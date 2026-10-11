import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import ngeohash from 'ngeohash';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/auth.decorators.js';
import { DEFAULT_PRICES } from '../common/money.js';
import { offsetOf, type Paginated, paginated } from '../common/pagination.js';
import { UrlService } from '../common/urls.service.js';
import { type MediaOwnerView, toMediaOwnerView } from '../common/views.js';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { media, orders, verifications } from '../db/schema.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { imageDimensions } from '../processing/image-files.js';
import { MAX_DECODE_PIXELS as MAX_PHOTO_PIXELS } from '../processing/ffmpeg.js';
import { MediaQueue } from '../processing/media-queue.service.js';
import { StorageService, storageKeys } from '../storage/storage.service.js';
import { detectFileType, SNIFF_BYTES } from './file-type.js';
import type { ListMyMediaQuery, UpdateMediaDto, UploadMediaDto } from './media.dto.js';
import { cleanOriginalName, readHead, sha256File } from './upload-files.js';

type MediaRow = typeof media.$inferSelect;

/** Capture time may be a little in the future (phone clocks drift)... */
export const CAPTURED_AT_FUTURE_ALLOWANCE_MS = 5 * 60_000;
/** ...but not older than this: Micky is for fresh news footage. */
export const CAPTURED_AT_MAX_AGE_DAYS = 30;
/** Geohash precision used for clustering incidents (about 1.2 km × 0.6 km). */
const GEOHASH_PRECISION = 6;

export const DUPLICATE_MESSAGE = 'This file has already been uploaded';

/**
 * Per-uploader limits (review M6). Any self-registered account can upload, so one
 * account must not be able to fill the disk or starve the single worker that every
 * real witness depends on. Generous for a person, tight for a script.
 */
export const UPLOAD_LIMITS = {
  /** Uploads still waiting for or inside the worker. */
  inFlight: 3,
  perHour: 20,
  bytesPerDay: 3 * 1024 * 1024 * 1024,
} as const;
/** Bytes of a photo read to find its declared pixel size (EXIF before the frame header can be 64 KB). */
const PHOTO_HEADER_BYTES = 256 * 1024;

/** Uploader-facing media: upload, list, read, edit, remove (docs/API.md, "Uploader: media"). */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly config: AppConfig,
    private readonly storage: StorageService,
    private readonly urls: UrlService,
    private readonly queue: MediaQueue,
    private readonly incidents: IncidentsService,
  ) {}

  // ---------- Upload ----------

  /**
   * The file is already on local disk (multer). Here we:
   * 1. check what it really is (magic bytes) and its size for that type;
   * 2. validate the claimed capture time and prices;
   * 3. compute its SHA-256 and reject exact duplicates (409);
   * 4. copy it to storage, insert the media row (PROCESSING) and enqueue processing.
   * DeleteTempUploadInterceptor removes the temp file afterwards on every path.
   */
  async upload(user: AuthUser, file: Express.Multer.File | undefined, dto: UploadMediaDto): Promise<MediaOwnerView> {
    if (!file) throw new BadRequestException('file is required');

    const type = detectFileType(await readHead(file.path, SNIFF_BYTES));
    if (!type) {
      throw new UnsupportedMediaTypeException(
        'Unsupported file type. Upload an MP4, MOV or WebM video, or a JPEG, PNG, HEIC or WebP photo.',
      );
    }
    const maxBytes = type.kind === 'VIDEO' ? this.config.maxVideoBytes : this.config.maxPhotoBytes;
    if (file.size > maxBytes) {
      throw new PayloadTooLargeException(
        `${type.kind === 'VIDEO' ? 'Videos' : 'Photos'} can be at most ${Math.floor(maxBytes / (1024 * 1024))} MB`,
      );
    }

    if (type.kind === 'PHOTO') {
      // Decompression-bomb guard, from the header alone (nothing is decoded here).
      const size = imageDimensions(Buffer.from(await readHead(file.path, PHOTO_HEADER_BYTES)));
      if (size && size.width * size.height > MAX_PHOTO_PIXELS) {
        throw new PayloadTooLargeException(`Photos can be at most ${MAX_PHOTO_PIXELS / 1_000_000} megapixels`);
      }
    }
    await this.checkQuota(user, file.size);

    const capturedAt = this.checkCapturedAt(dto.capturedAt);
    const defaults = DEFAULT_PRICES[type.kind];
    const priceNonExclusive = dto.priceNonExclusive ?? defaults.NON_EXCLUSIVE;
    const priceExclusive = dto.priceExclusive ?? defaults.EXCLUSIVE;
    checkPrices(priceNonExclusive, priceExclusive);

    const checksum = await sha256File(file.path);
    // Cheap early check, so a duplicate is not copied into storage first.
    if (await this.checksumTaken(this.db, checksum)) throw new ConflictException(DUPLICATE_MESSAGE);

    const id = randomUUID();
    const originalKey = storageKeys.original(id, type.ext);
    await this.storage.putFile(originalKey, file.path, type.mime);

    let row: MediaRow;
    try {
      row = await this.db.transaction(async (tx) => {
        // Two uploads of the same file at the same moment would both pass the early
        // check. This lock (one per checksum, released at commit) makes the second
        // one wait, re-check, and get the 409. (The schema has no unique index on
        // checksum because FAILED uploads may be retried.)
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`micky:checksum:${checksum}`}))`);
        if (await this.checksumTaken(tx, checksum)) throw new ConflictException(DUPLICATE_MESSAGE);
        const [inserted] = await tx
          .insert(media)
          .values({
            id,
            uploaderId: user.id,
            type: type.kind,
            status: 'PROCESSING',
            title: dto.title,
            description: dto.description ?? null,
            category: dto.category,
            latitude: dto.latitude,
            longitude: dto.longitude,
            geohash: ngeohash.encode(dto.latitude, dto.longitude, GEOHASH_PRECISION),
            locationName: dto.locationName ?? null,
            capturedAt,
            originalKey,
            originalName: cleanOriginalName(file.originalname),
            mimeType: type.mime,
            sizeBytes: file.size,
            checksum,
            priceNonExclusive,
            priceExclusive,
          })
          .returning();
        return inserted;
      });
    } catch (err) {
      await this.deleteOriginal(id);
      throw err;
    }

    try {
      await this.queue.enqueue(row.id);
    } catch (err) {
      // Without a job the upload would sit in PROCESSING forever. Undo it so the
      // uploader can simply try again (the checksum is free again).
      this.logger.error(`Could not enqueue media ${row.id}: ${(err as Error).message}`);
      await this.db.delete(media).where(eq(media.id, row.id));
      await this.deleteOriginal(id);
      throw new ServiceUnavailableException('Uploads are temporarily unavailable. Please try again in a minute.');
    }

    this.logger.log(`Media ${row.id} uploaded (${type.mime}, ${file.size} bytes)`);
    return toMediaOwnerView(row, { urls: this.urls });
  }

  // ---------- Read ----------

  async list(user: AuthUser, query: ListMyMediaQuery): Promise<Paginated<MediaOwnerView>> {
    const where = and(eq(media.uploaderId, user.id), query.status ? eq(media.status, query.status) : undefined);
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(media)
        .where(where)
        .orderBy(desc(media.createdAt), desc(media.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ total: count() }).from(media).where(where),
    ]);
    return paginated(await this.toViews(rows), total, query);
  }

  async get(user: AuthUser, id: string): Promise<MediaOwnerView> {
    const row = await this.db.query.media.findFirst({ where: and(eq(media.id, id), eq(media.uploaderId, user.id)) });
    // 404 (not 403) for someone else's media, so ids cannot be probed.
    if (!row) throw new NotFoundException('Media not found');
    return (await this.toViews([row]))[0];
  }

  // ---------- Edit / remove ----------

  async update(user: AuthUser, id: string, dto: UpdateMediaDto): Promise<MediaOwnerView> {
    const updated = await this.db.transaction(async (tx) => {
      // FOR UPDATE: marking an order PAID locks the same row, so a price change and
      // a sale cannot interleave ("not sold" is still true when we write).
      const [row] = await tx
        .select()
        .from(media)
        .where(and(eq(media.id, id), eq(media.uploaderId, user.id)))
        .for('update');
      if (!row) throw new NotFoundException('Media not found');
      if (row.status === 'REMOVED') throw new ConflictException('This media has been removed and cannot be edited');

      const priceNonExclusive = dto.priceNonExclusive ?? row.priceNonExclusive;
      const priceExclusive = dto.priceExclusive ?? row.priceExclusive;
      const pricesChanged = priceNonExclusive !== row.priceNonExclusive || priceExclusive !== row.priceExclusive;
      if (pricesChanged) {
        if (row.exclusiveSold || (await this.paidOrderCount(tx, row.id)) > 0) {
          throw new ConflictException('Prices cannot be changed after the media has been sold');
        }
        checkPrices(priceNonExclusive, priceExclusive);
      }

      const [saved] = await tx
        .update(media)
        .set({
          title: dto.title ?? row.title,
          description: dto.description === undefined ? row.description : dto.description || null,
          priceNonExclusive,
          priceExclusive,
        })
        .where(eq(media.id, row.id))
        .returning();
      return saved;
    });
    return (await this.toViews([updated]))[0];
  }

  /**
   * Takes the media off Micky (status REMOVED). Not allowed once a channel
   * has paid for it: the buyer's licence and download must keep working.
   * The files are kept (reports and audits may need them); every read path
   * already refuses REMOVED media.
   */
  async remove(user: AuthUser, id: string): Promise<void> {
    const removed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(media)
        .where(and(eq(media.id, id), eq(media.uploaderId, user.id)))
        .for('update');
      if (!row) throw new NotFoundException('Media not found');
      if (row.status === 'REMOVED') return null; // already removed: deleting twice is fine
      if ((await this.paidOrderCount(tx, row.id)) > 0) {
        throw new ConflictException('This media has been sold and cannot be removed');
      }
      const [saved] = await tx.update(media).set({ status: 'REMOVED' }).where(eq(media.id, row.id)).returning();
      return saved;
    });
    // After commit: if it was approved, the incident's counters and trend change.
    if (removed?.incidentId) await this.incidents.recompute(removed.incidentId);
  }

  // ---------- Helpers ----------

  /** Owner views for a page of rows, with verifications and sales loaded in 2 batched queries. */
  private async toViews(rows: MediaRow[]): Promise<MediaOwnerView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [verificationRows, sales] = await Promise.all([
      this.db.select().from(verifications).where(inArray(verifications.mediaId, ids)),
      this.db
        .select({
          mediaId: orders.mediaId,
          salesCount: sql<number>`count(*)`.mapWith(Number),
          earned: sql<number>`coalesce(sum(${orders.uploaderShare}), 0)`.mapWith(Number),
        })
        .from(orders)
        .where(and(inArray(orders.mediaId, ids), eq(orders.status, 'PAID')))
        .groupBy(orders.mediaId),
    ]);
    const verificationById = new Map(verificationRows.map((v) => [v.mediaId, v]));
    const salesById = new Map(sales.map((s) => [s.mediaId, s]));
    return rows.map((row) =>
      toMediaOwnerView(row, {
        urls: this.urls,
        verification: verificationById.get(row.id) ?? null,
        salesCount: salesById.get(row.id)?.salesCount ?? 0,
        earned: salesById.get(row.id)?.earned ?? 0,
        includeMetadata: false, // GPS/device details are for admins only
      }),
    );
  }

  /**
   * Is this exact file already on Micky? FAILED uploads do not count, so an
   * uploader whose file failed processing can try again (the web app suggests it).
   */
  private async checksumTaken(db: Pick<Database, 'select'>, checksum: string): Promise<boolean> {
    const [found] = await db
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.checksum, checksum), ne(media.status, 'FAILED')))
      .limit(1);
    return !!found;
  }

  /** 429 when this uploader is over UPLOAD_LIMITS. Counted from the media table, no extra state. */
  private async checkQuota(user: AuthUser, incomingBytes: number): Promise<void> {
    const now = Date.now();
    const [usage] = await this.db
      .select({
        inFlight: sql<number>`count(*) filter (where ${media.status} = 'PROCESSING')`.mapWith(Number),
        lastHour: sql<number>`count(*) filter (where ${media.createdAt} >= ${new Date(now - 3_600_000)})`.mapWith(Number),
        bytesToday: sql<number>`coalesce(sum(${media.sizeBytes}), 0)`.mapWith(Number),
      })
      .from(media)
      .where(and(eq(media.uploaderId, user.id), gte(media.createdAt, new Date(now - 24 * 3_600_000))));
    const tooMany = (message: string) => new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
    if (usage.inFlight >= UPLOAD_LIMITS.inFlight) {
      throw tooMany('Please wait until your earlier uploads have finished processing, then try again.');
    }
    if (usage.lastHour >= UPLOAD_LIMITS.perHour) throw tooMany('You have uploaded a lot in the last hour. Please try again later.');
    if (usage.bytesToday + incomingBytes > UPLOAD_LIMITS.bytesPerDay) {
      throw tooMany('You have reached today’s upload limit. Please try again tomorrow.');
    }
  }

  private async paidOrderCount(db: Pick<Database, 'select'>, mediaId: string): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.mediaId, mediaId), eq(orders.status, 'PAID')));
    return n;
  }

  private checkCapturedAt(value: string): Date {
    const capturedAt = new Date(value);
    const now = Date.now();
    if (Number.isNaN(capturedAt.getTime())) throw new BadRequestException('capturedAt must be a valid date');
    if (capturedAt.getTime() > now + CAPTURED_AT_FUTURE_ALLOWANCE_MS) {
      throw new BadRequestException('capturedAt cannot be in the future');
    }
    if (capturedAt.getTime() < now - CAPTURED_AT_MAX_AGE_DAYS * 24 * 3_600_000) {
      throw new BadRequestException(`capturedAt cannot be more than ${CAPTURED_AT_MAX_AGE_DAYS} days ago`);
    }
    return capturedAt;
  }

  private async deleteOriginal(id: string) {
    await this.storage
      .deletePrefix(`originals/${id}`)
      .catch((err: Error) => this.logger.warn(`Could not delete original of ${id}: ${err.message}`));
  }
}

function checkPrices(nonExclusive: number, exclusive: number) {
  if (exclusive < nonExclusive) {
    throw new BadRequestException('priceExclusive must be at least priceNonExclusive');
  }
}
