import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { AuthUser } from '../common/auth.decorators.js';
import { SigningService } from '../common/signing.service.js';
import { DOWNLOAD_TTL_SEC, TOKEN } from '../common/urls.service.js';
import { deliveryFileName } from '../common/views.js';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { channelProfiles, media, orders, users, verifications } from '../db/schema.js';
import { readDeliveryInfo } from '../processing/delivery.js';
import { MediaQueue } from '../processing/media-queue.service.js';
import { previewKeys, viewerTag } from '../processing/preview-plan.js';
import { RedisService } from '../processing/redis.service.js';
import { StorageService, storageKeys } from '../storage/storage.service.js';
import { decidePreviewAccess, type PreviewViewer } from './preview-access.js';

type MediaRow = typeof media.$inferSelect;

export type PreviewSession =
  | { kind: 'hls'; playlistUrl: string; expiresAt: string; watermarkText: string }
  | { kind: 'image'; imageUrl: string; expiresAt: string; watermarkText: string }
  /** 202: the newsroom's marked copy is being rendered; ask again after `retryAfterSec`. */
  | { kind: 'preparing'; retryAfterSec: number };

/** A file ready to be sent: the stream plus the headers the controller sets. */
export interface FileToSend {
  stream: Readable;
  size?: number;
  contentType: string;
  fileName?: string; // set for downloads (Content-Disposition: attachment)
  sha256?: string; // set for downloads (X-Content-SHA256 / Repr-Digest)
  orderId?: string; // set for downloads, to count completed ones
}

/** Only HLS segment names the worker produces: seg_000.ts ... seg_99999.ts. */
export const SEGMENT_NAME = /^seg_\d{3,5}\.ts$/;

/**
 * Token purposes and lifetimes of a preview session (review H4). All carry
 * `{ m: mediaId, u: viewerId }`, and every request re-checks access for that viewer
 * and reads that viewer's own rendition, so a shared link shows the sharer's name.
 * - playlist: must be loaded right away (the player does), so 2 minutes;
 * - key:      minted when the playlist is served, fetched once by the player: 2 minutes;
 * - file:     segments and the preview image, for the whole 10-minute session.
 */
export const STREAM_TOKEN = {
  playlist: 'stream-playlist',
  key: 'stream-key',
  file: TOKEN.stream,
} as const;
export const PLAYLIST_TTL_SEC = 2 * 60;
export const KEY_TTL_SEC = 2 * 60;
export const SESSION_TTL_SEC = 10 * 60;

/** How long POST /preview waits for a first-view render before answering 202 "preparing". */
export const RENDER_WAIT_MS = 20_000;
const RENDER_POLL_MS = 250;

/**
 * A download link must be redeemed within this many seconds of being issued, and
 * only once (review M3). It is minted with DOWNLOAD_TTL_SEC by the orders module;
 * the issue time is `exp - DOWNLOAD_TTL_SEC`.
 */
export const DOWNLOAD_REDEEM_WINDOW_SEC = 2 * 60;
/** Completed-or-started downloads allowed per order per hour. */
export const DOWNLOADS_PER_ORDER_PER_HOUR = 20;

/** Same message for every bad token (malformed, tampered, expired, wrong purpose), so nothing leaks. */
const INVALID_LINK = 'This link is invalid or has expired';

type Viewer = PreviewViewer & { displayName: string };

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);
  /** RENDER_WAIT_MS; a field so tests can shorten it. */
  renderWaitMs = RENDER_WAIT_MS;

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly config: AppConfig,
    private readonly signing: SigningService,
    private readonly storage: StorageService,
    private readonly queue: MediaQueue,
    private readonly redis: RedisService,
  ) {}

  private get apiBase() {
    return `${this.config.publicApiUrl}/api/v1`;
  }

  // ---------- Preview sessions ----------

  /**
   * Starts a 10-minute preview session: checks access, makes sure a newsroom has its
   * own marked rendition (rendered by the worker on the first view), then returns
   * signed URLs plus the text the player overlays (who is watching, and when).
   */
  async createPreview(user: AuthUser, mediaId: string): Promise<PreviewSession> {
    const row = await this.loadMedia(mediaId);
    const viewer = row ? await this.loadViewer(user.id, row) : null;
    if (!viewer || !row) throw new NotFoundException('Media not found');

    const decision = decidePreviewAccess(viewer, row);
    if (decision === 'forbidden') throw new ForbiddenException('Your news organisation has not been approved yet');
    if (decision === 'sold') {
      throw new GoneException('This media has been licensed exclusively to another organisation, so its preview is closed.');
    }
    if (decision === 'not-found') throw new NotFoundException('Media not found');

    if (!hasPreview(row)) {
      throw new ConflictException('The preview is not ready yet. Try again when processing has finished.');
    }
    if (viewer.role === 'CHANNEL' && !(await this.ensureRendition(row, viewer.id))) {
      return { kind: 'preparing', retryAfterSec: 3 };
    }

    const m = row.id;
    const u = viewer.id;
    const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
    const watermarkText = `Preview · ${viewer.displayName} · ${viewerTag(viewer.id)} · ${formatIst(new Date())}`;
    if (row.type === 'VIDEO') {
      const token = this.signing.sign(STREAM_TOKEN.playlist, { m, u }, PLAYLIST_TTL_SEC);
      return { kind: 'hls', playlistUrl: `${this.apiBase}/stream/${token}/index.m3u8`, expiresAt, watermarkText };
    }
    const token = this.signing.sign(STREAM_TOKEN.file, { m, u }, SESSION_TTL_SEC);
    return { kind: 'image', imageUrl: `${this.apiBase}/stream/${token}/image.jpg`, expiresAt, watermarkText };
  }

  /**
   * True when this newsroom's rendition is in storage. Otherwise asks the worker for
   * one and waits up to RENDER_WAIT_MS (a 30 s clip renders in a few seconds), then
   * gives up with false: the player shows "preparing" and asks again.
   */
  private async ensureRendition(row: MediaRow, viewerId: string): Promise<boolean> {
    const key =
      row.type === 'VIDEO' ? previewKeys.viewerPlaylist(row.id, viewerId) : previewKeys.viewerImage(row.id, viewerId);
    if (await this.exists(key)) return true;

    const job = await this.queue.enqueueViewerRender(row.id, viewerId);
    const deadline = Date.now() + this.renderWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RENDER_POLL_MS));
      if (await this.exists(key)) return true;
      if ((await job.getState()) === 'failed') {
        this.logger.warn(`Preview render failed for ${row.id}/${viewerId}: ${job.failedReason ?? '?'}`);
        throw new ServiceUnavailableException('The preview could not be prepared. Please try again in a minute.');
      }
    }
    return false;
  }

  // ---------- Token-protected preview files ----------

  /**
   * The HLS playlist of this viewer's rendition. The worker writes a placeholder key
   * URI; here every URI is rewritten to a path relative to this playlist, with its
   * own short-lived token: the key gets a 2-minute key token, segments the session
   * token. So the key is never reachable with the long-lived segment token.
   */
  async playlist(token: string): Promise<string> {
    const { row, viewer } = await this.authorizeStream(token, STREAM_TOKEN.playlist, 'VIDEO');
    const { stream } = await this.storage.getStream(this.renditionKey(row, viewer, 'index.m3u8'));
    const text = await readText(stream);
    const claims = { m: row.id, u: viewer.id };
    const keyToken = this.signing.sign(STREAM_TOKEN.key, claims, KEY_TTL_SEC);
    const fileToken = this.signing.sign(STREAM_TOKEN.file, claims, SESSION_TTL_SEC);
    return text
      .replace(/^(#EXT-X-KEY:.*?URI=)"[^"]*"/gm, `$1"../${keyToken}/key.bin"`)
      .replace(/^(seg_\d{3,5}\.ts)\s*$/gm, `../${fileToken}/$1`);
  }

  async segment(token: string, name: string): Promise<FileToSend> {
    // Check the name before anything else: it is the only user-controlled part of the storage key.
    if (!SEGMENT_NAME.test(name)) throw new NotFoundException('Segment not found');
    const { row, viewer } = await this.authorizeStream(token, STREAM_TOKEN.file, 'VIDEO');
    const file = await this.storage.getStream(this.renditionKey(row, viewer, name));
    return { ...file, contentType: 'video/mp2t' };
  }

  /** The 16-byte AES-128 key. It lives in the database, never in storage next to the segments. */
  async hlsKey(token: string): Promise<Buffer> {
    const { row } = await this.authorizeStream(token, STREAM_TOKEN.key, 'VIDEO');
    const key = Buffer.from(row.hlsKeyHex ?? '', 'hex');
    if (key.length !== 16) throw new NotFoundException('Key not found');
    return key;
  }

  async previewImage(token: string): Promise<FileToSend> {
    const { row, viewer } = await this.authorizeStream(token, STREAM_TOKEN.file, 'PHOTO');
    const file = await this.storage.getStream(this.renditionKey(row, viewer, 'image.jpg'));
    return { ...file, contentType: 'image/jpeg' };
  }

  /**
   * Where a viewer's preview files are. Newsrooms get their own marked rendition
   * (`previews/<id>/v/<userId>/`); the owner and admins the generic one.
   */
  private renditionKey(row: MediaRow, viewer: Viewer, name: string): string {
    if (viewer.role === 'CHANNEL') return `${previewKeys.viewerDir(row.id, viewer.id)}/${name}`;
    if (row.type === 'PHOTO') return storageKeys.previewImage(row.id);
    return `${storageKeys.hlsDir(row.id)}/${name}`;
  }

  // ---------- Thumbnails and downloads ----------

  /** Watermarked thumbnail. Low value (it is in every list), so only "exists and not taken down" is checked. */
  async thumbnail(token: string): Promise<FileToSend> {
    const payload = this.signing.verify<{ m: string }>(TOKEN.thumb, token);
    if (!payload || !isUuid(payload.m)) throw new UnauthorizedException(INVALID_LINK);

    const row = await this.loadMedia(payload.m);
    if (!row?.thumbKey || row.status === 'REMOVED') throw new NotFoundException('Thumbnail not found');
    const file = await this.storage.getStream(row.thumbKey);
    return { ...file, contentType: 'image/jpeg' };
  }

  /**
   * The buyer's **delivery copy** (identifying metadata removed, review H3) for a
   * PAID order. The token is minted by the orders module (GET /orders/:id/download),
   * which checks the buyer's session. Here (review M3):
   * - the link must be redeemed within DOWNLOAD_REDEEM_WINDOW_SEC of being issued;
   * - if it names a buyer (`u`), the order must be theirs;
   * - it works exactly once (a Redis `SET NX` on the token's hash, claimed before the
   *   first byte), so a forwarded link is useless once the buyer has used it;
   * - at most DOWNLOADS_PER_ORDER_PER_HOUR per order;
   * - the order must still be PAID and the media not taken down.
   * The untouched original is never served here; until the worker has made the copy
   * the answer is 409 "being prepared" (and a job is queued).
   */
  async download(token: string): Promise<FileToSend> {
    const payload = this.signing.verify<{ o: string; u?: string }>(TOKEN.download, token);
    if (!payload || !isUuid(payload.o) || (payload.u !== undefined && !isUuid(payload.u))) {
      throw new UnauthorizedException(INVALID_LINK);
    }
    const issuedAt = payload.exp - DOWNLOAD_TTL_SEC;
    if (Math.floor(Date.now() / 1000) > issuedAt + DOWNLOAD_REDEEM_WINDOW_SEC) {
      throw new UnauthorizedException(INVALID_LINK);
    }

    const [found] = await this.db
      .select({ order: orders, media, metadata: verifications.metadata })
      .from(orders)
      .innerJoin(media, eq(media.id, orders.mediaId))
      .leftJoin(verifications, eq(verifications.mediaId, media.id))
      .where(eq(orders.id, payload.o))
      .limit(1);
    if (!found || found.order.status !== 'PAID') throw new NotFoundException('Order not found');
    if (payload.u && payload.u !== found.order.buyerId) throw new NotFoundException('Order not found');
    if (found.media.status === 'REMOVED') throw new NotFoundException('This media has been taken down');

    const delivery = readDeliveryInfo(found.metadata);
    if (!delivery) {
      await this.queue.enqueueDelivery(found.media.id);
      throw new ConflictException('The file is being prepared for download. Please try again in a minute.');
    }

    const client = this.redis.client;
    const rateKey = `micky:download-rate:${found.order.id}`;
    const used = await client.incr(rateKey);
    if (used === 1) await client.expire(rateKey, 3600);
    if (used > DOWNLOADS_PER_ORDER_PER_HOUR) {
      throw new HttpException('Too many downloads of this order. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const claimTtl = Math.max(60, payload.exp - Math.floor(Date.now() / 1000) + 60);
    const claimed = await client.set(`micky:download-used:${sha256(token)}`, found.order.id, 'EX', claimTtl, 'NX');
    if (claimed !== 'OK') {
      throw new GoneException('This download link has already been used. Start the download again from your purchases.');
    }

    const file = await this.storage.getStream(delivery.key);
    return {
      ...file,
      contentType: delivery.mimeType,
      fileName: deliveryFileName(found.media),
      sha256: delivery.sha256,
      orderId: found.order.id,
    };
  }

  /** Called when the whole file has been handed to the network: counts one real download. */
  async countCompletedDownload(orderId: string): Promise<void> {
    await this.db
      .update(orders)
      .set({ downloadCount: sql`${orders.downloadCount} + 1` })
      .where(eq(orders.id, orderId));
  }

  // ---------- Helpers ----------

  /**
   * Verifies a stream token of the given purpose and re-checks access with fresh
   * data from the database (the media could have been removed or sold exclusively,
   * or the channel un-approved, since the token was issued). Bad tokens give 401;
   * lost access gives 404.
   */
  private async authorizeStream(
    token: string,
    purpose: string,
    type: MediaRow['type'],
  ): Promise<{ row: MediaRow; viewer: Viewer }> {
    const payload = this.signing.verify<{ m: string; u: string }>(purpose, token);
    if (!payload || !isUuid(payload.m) || !isUuid(payload.u)) throw new UnauthorizedException(INVALID_LINK);

    const row = await this.loadMedia(payload.m);
    const viewer = row ? await this.loadViewer(payload.u, row) : null;
    if (!viewer || !row || decidePreviewAccess(viewer, row) !== 'ok') {
      throw new NotFoundException('Preview not found');
    }
    // A photo token cannot fetch HLS files and vice versa.
    if (row.type !== type || !hasPreview(row)) throw new NotFoundException('Preview not found');
    return { row, viewer };
  }

  private async loadViewer(userId: string, target: MediaRow): Promise<Viewer | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        role: users.role,
        name: users.name,
        organization: channelProfiles.organization,
        channelStatus: channelProfiles.status,
      })
      .from(users)
      .leftJoin(channelProfiles, eq(channelProfiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return null;
    let holdsExclusive = false;
    if (row.role === 'CHANNEL' && target.exclusiveSold) {
      const [own] = await this.db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.mediaId, target.id),
            eq(orders.buyerId, row.id),
            eq(orders.status, 'PAID'),
            eq(orders.licenseType, 'EXCLUSIVE'),
          ),
        )
        .limit(1);
      holdsExclusive = !!own;
    }
    return {
      id: row.id,
      role: row.role,
      channelStatus: row.channelStatus,
      holdsExclusive,
      displayName: row.organization ?? row.name,
    };
  }

  private async loadMedia(id: string): Promise<MediaRow | undefined> {
    return this.db.query.media.findFirst({ where: eq(media.id, id) });
  }

  private async exists(key: string): Promise<boolean> {
    try {
      const { stream } = await this.storage.getStream(key);
      stream.destroy();
      return true;
    } catch (err) {
      if (err instanceof NotFoundException) return false;
      throw err;
    }
  }
}

/**
 * Has the worker produced a playable preview? `previewKey` is set by the worker
 * when it finishes; files are then read from the standard `storageKeys` paths.
 * Videos also need their AES key.
 */
function hasPreview(row: MediaRow): boolean {
  if (!row.previewKey) return false;
  return row.type === 'PHOTO' || !!row.hlsKeyHex;
}

/** Postgres rejects malformed UUIDs with an error; check first so a forged payload is just a 401. */
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** "2026-10-11 14:05 IST": India has one time zone and no daylight saving. */
export function formatIst(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} IST`;
}

/** Reads a small text file (a playlist is a few KB) from a stream. */
async function readText(stream: Readable, maxBytes = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error('Playlist is unexpectedly large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
