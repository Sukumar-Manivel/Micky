import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { AuthUser } from '../common/auth.decorators.js';
import { SigningService } from '../common/signing.service.js';
import { TOKEN, UrlService } from '../common/urls.service.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { channelProfiles, media, orders, users } from '../db/schema.js';
import { StorageService, storageKeys } from '../storage/storage.service.js';
import { decidePreviewAccess, type PreviewViewer } from './preview-access.js';

type MediaRow = typeof media.$inferSelect;

export type PreviewSession =
  | { kind: 'hls'; playlistUrl: string; expiresAt: string; watermarkText: string }
  | { kind: 'image'; imageUrl: string; expiresAt: string; watermarkText: string };

/** A file ready to be sent: the stream plus the headers the controller sets. */
export interface FileToSend {
  stream: Readable;
  size?: number;
  contentType: string;
  fileName?: string; // set for downloads (Content-Disposition: attachment)
}

/** Only HLS segment names the worker produces: seg_000.ts ... seg_99999.ts. */
export const SEGMENT_NAME = /^seg_\d{3,5}\.ts$/;

/** Same message for every bad token (malformed, tampered, expired, wrong purpose), so nothing leaks. */
const INVALID_LINK = 'This link is invalid or has expired';

@Injectable()
export class StreamService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly signing: SigningService,
    private readonly urls: UrlService,
    private readonly storage: StorageService,
  ) {}

  // ---------- Preview sessions ----------

  /**
   * Starts a 10-minute preview session: checks access, then returns signed URLs
   * plus the text the player overlays (who is watching, and when).
   */
  async createPreview(user: AuthUser, mediaId: string): Promise<PreviewSession> {
    const [viewer, row] = await Promise.all([this.loadViewer(user.id), this.loadMedia(mediaId)]);
    if (!viewer || !row) throw new NotFoundException('Media not found');

    const decision = decidePreviewAccess(viewer, row);
    if (decision === 'forbidden') throw new ForbiddenException('Your news organisation has not been approved yet');
    if (decision === 'not-found') throw new NotFoundException('Media not found');

    if (!hasPreview(row)) {
      throw new ConflictException('The preview is not ready yet. Try again when processing has finished.');
    }

    const { base, expiresAt } = this.urls.streamBase(row.id, viewer.id);
    const watermarkText = `Preview · ${viewer.displayName} · ${formatIst(new Date())}`;
    return row.type === 'VIDEO'
      ? { kind: 'hls', playlistUrl: `${base}index.m3u8`, expiresAt: expiresAt.toISOString(), watermarkText }
      : { kind: 'image', imageUrl: `${base}image.jpg`, expiresAt: expiresAt.toISOString(), watermarkText };
  }

  // ---------- Token-protected preview files ----------

  /**
   * The HLS playlist. It is read as text and its key line is rewritten to the
   * relative "key.bin", so the player always fetches the key through our
   * checked route (never from a storage path written into the file).
   */
  async playlist(token: string): Promise<string> {
    const row = await this.authorizeStream(token, 'VIDEO');
    const { stream } = await this.storage.getStream(storageKeys.hlsPlaylist(row.id));
    const text = await readText(stream);
    return text.replace(/^(#EXT-X-KEY:.*?URI=)"[^"]*"/gm, '$1"key.bin"');
  }

  async segment(token: string, name: string): Promise<FileToSend> {
    // Check the name before anything else: it is the only user-controlled part of the storage key.
    if (!SEGMENT_NAME.test(name)) throw new NotFoundException('Segment not found');
    const row = await this.authorizeStream(token, 'VIDEO');
    const file = await this.storage.getStream(`${storageKeys.hlsDir(row.id)}/${name}`);
    return { ...file, contentType: 'video/mp2t' };
  }

  /** The 16-byte AES-128 key. It lives in the database, never in storage next to the segments. */
  async hlsKey(token: string): Promise<Buffer> {
    const row = await this.authorizeStream(token, 'VIDEO');
    const key = Buffer.from(row.hlsKeyHex ?? '', 'hex');
    if (key.length !== 16) throw new NotFoundException('Key not found');
    return key;
  }

  async previewImage(token: string): Promise<FileToSend> {
    const row = await this.authorizeStream(token, 'PHOTO');
    const file = await this.storage.getStream(storageKeys.previewImage(row.id));
    return { ...file, contentType: 'image/jpeg' };
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
   * The original file, for a PAID order. The token is minted by the orders module
   * (GET /orders/:id/download), which checks the buyer; here we re-check the
   * order is still PAID and the media has not been taken down.
   */
  async download(token: string): Promise<FileToSend> {
    const payload = this.signing.verify<{ o: string }>(TOKEN.download, token);
    if (!payload || !isUuid(payload.o)) throw new UnauthorizedException(INVALID_LINK);

    const [found] = await this.db
      .select({ order: orders, media })
      .from(orders)
      .innerJoin(media, eq(media.id, orders.mediaId))
      .where(eq(orders.id, payload.o))
      .limit(1);
    if (!found || found.order.status !== 'PAID') throw new NotFoundException('Order not found');
    if (found.media.status === 'REMOVED') throw new NotFoundException('This media has been taken down');

    const file = await this.storage.getStream(found.media.originalKey);
    return { ...file, contentType: found.media.mimeType, fileName: downloadFileName(found.media) };
  }

  // ---------- Helpers ----------

  /**
   * Verifies a stream token and re-checks access with fresh data from the
   * database (the media could have been removed, or the channel un-approved,
   * since the token was issued). Bad tokens give 401; lost access gives 404.
   */
  private async authorizeStream(token: string, type: MediaRow['type']): Promise<MediaRow> {
    const payload = this.signing.verify<{ m: string; u: string }>(TOKEN.stream, token);
    if (!payload || !isUuid(payload.m) || !isUuid(payload.u)) throw new UnauthorizedException(INVALID_LINK);

    const [viewer, row] = await Promise.all([this.loadViewer(payload.u), this.loadMedia(payload.m)]);
    if (!viewer || !row || decidePreviewAccess(viewer, row) !== 'ok') {
      throw new NotFoundException('Preview not found');
    }
    // A photo token cannot fetch HLS files and vice versa.
    if (row.type !== type || !hasPreview(row)) throw new NotFoundException('Preview not found');
    return row;
  }

  private async loadViewer(userId: string): Promise<(PreviewViewer & { displayName: string }) | null> {
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
    return {
      id: row.id,
      role: row.role,
      channelStatus: row.channelStatus,
      displayName: row.organization ?? row.name,
    };
  }

  private async loadMedia(id: string): Promise<MediaRow | undefined> {
    return this.db.query.media.findFirst({ where: eq(media.id, id) });
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

/**
 * A safe download name: the title reduced to letters, digits, spaces and dashes,
 * plus the original's extension (taken from our own storage key, not the user's file name).
 */
export function downloadFileName(row: Pick<MediaRow, 'title' | 'originalKey'>): string {
  const base =
    row.title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80)
      .replace(/^-|-$/g, '') || 'firstframe-media';
  const ext = path.extname(row.originalKey).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? `${base}${ext}` : base;
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
