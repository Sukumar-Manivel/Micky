import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import exifr from 'exifr';
import { randomBytes } from 'node:crypto';
import { open as openFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { channelProfiles, media, users, verifications } from '../db/schema.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { sha256File } from '../media/upload-files.js';
import { StorageService, storageKeys } from '../storage/storage.service.js';
import {
  ALLOWED_PHOTO_TAGS,
  ALLOWED_VIDEO_TAGS,
  type DeliveryInfo,
  deliveryExt,
  deliveryKey,
  deliveryMimeType,
  readDeliveryInfo,
} from './delivery.js';
import { PermanentProcessingError } from './errors.js';
import {
  encodeMezzanine,
  ffprobe,
  firstFrameRotation,
  MAX_DECODE_PIXELS,
  makeWatermark,
  photoFrame,
  reencodePhotoAsJpeg,
  renderViewerHls,
  renderWatermarkedJpeg,
  sampleVideoFrames,
  segmentHls,
  stripVideoMetadata,
} from './ffmpeg.js';
import { ImageFormatError, imageDimensions, imageFormatOf, stripImageMetadata } from './image-files.js';
import { type ExifData, type FileMetadata, fitWithin, readExif, readVideoProbe, uprightSize } from './media-metadata.js';
import {
  PHOTO_PREVIEW,
  previewKeys,
  THUMBNAIL,
  VIEWER_MARK,
  videoPreviewPlan,
  viewerMarkText,
} from './preview-plan.js';
import { DUPLICATE_MAX_DISTANCE, isInformativePhash, minDistance } from './phash.js';
import { assessRisk } from './risk.js';
import { VerifierClient, type VerifierResult, VerifierUnavailableError } from './verifier.client.js';

type MediaRow = typeof media.$inferSelect;

/**
 * Decompression-bomb and abuse limits (docs/learning/media-and-processing.md, "Limits").
 * Photos: 50 megapixels (a 200 MP phone mode is refused; normal phones shoot 12–50 MP).
 * Videos: 4K. Checked from headers before any frame is decoded.
 */
export const MAX_PHOTO_PIXELS = MAX_DECODE_PIXELS;
export const MAX_VIDEO_PIXELS = 4096 * 2304;
/** Bytes of a photo read to find its declared size (JPEG EXIF blocks can be up to 64 KB). */
const HEADER_BYTES = 256 * 1024;
/** Frames sent to the AI detector: enough to cover a clip, few enough for a CPU model. */
const MAX_VERIFIER_FRAMES = 8;
/** Rows read per batch during the duplicate search. */
const DUPLICATE_SCAN_BATCH = 1000;

/** Everything the worker learns about the file before making outputs. */
interface Probed {
  durationSec: number | null;
  width: number;
  height: number;
  fileMetadata: FileMetadata;
  details: Record<string, unknown>;
}

export interface ProcessOptions {
  /**
   * True on the job's last attempt. If the verifier is still unreachable then,
   * processing continues without it (ai.available = false, recorded as a signal)
   * instead of failing the upload.
   */
  finalAttempt: boolean;
}

export type ProcessOutcome = 'processed' | 'skipped';

/**
 * Turns an uploaded original into everything the review queue and the marketplace need:
 *
 *   1. probe      ffprobe / EXIF: size, duration, capture time, GPS, device
 *   2. previews   watermarked 480p HLS (video) or JPEG (photo), plus a thumbnail
 *   3. verify     frames → verifier (AI score, C2PA, pHash), duplicate search, risk level
 *   4. incident   attach to a nearby incident or create one
 *   5. publish    PROCESSING → IN_REVIEW (the admin review queue)
 *
 * Every step is idempotent, because BullMQ retries a failed job from the start:
 * - steps 2 and 3 are skipped if their result is already in the database;
 * - the verification row is an upsert keyed by media id;
 * - assignIncident returns the existing incident if one is set;
 * - the final update only matches a row that is still PROCESSING.
 */
@Injectable()
export class MediaProcessingService {
  private readonly logger = new Logger(MediaProcessingService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly config: AppConfig,
    private readonly storage: StorageService,
    private readonly verifier: VerifierClient,
    private readonly incidents: IncidentsService,
  ) {}

  async process(mediaId: string, opts: ProcessOptions): Promise<ProcessOutcome> {
    const row = await this.db.query.media.findFirst({ where: eq(media.id, mediaId) });
    // Already processed, failed, or removed by the uploader while waiting: nothing to do.
    if (!row || row.status !== 'PROCESSING') return 'skipped';

    const workDir = await mkdtemp(path.join(tmpdir(), `firstframe-${mediaId}-`));
    try {
      const original = path.join(workDir, `original${path.extname(row.originalKey)}`);
      await this.storage.downloadTo(row.originalKey, original);

      const probed = row.type === 'VIDEO' ? await this.probeVideo(original) : await this.probePhoto(original);

      if (!hasPreviewOutputs(row)) await this.makePreviews(row, original, probed, workDir);

      let existing = await this.db.query.verifications.findFirst({ where: eq(verifications.mediaId, mediaId) });
      if (!existing) {
        await this.verify(row, original, probed, workDir, opts);
        existing = await this.db.query.verifications.findFirst({ where: eq(verifications.mediaId, mediaId) });
      }

      // The copy buyers download, without the witness's name, GPS or device (H3).
      if (!readDeliveryInfo(existing?.metadata)) await this.makeDelivery(row, original, workDir);

      await this.incidents.assignIncident(mediaId);

      // The commit point. Conditional, so a takedown that happened meanwhile is not overwritten.
      const done = await this.db
        .update(media)
        .set({ status: 'IN_REVIEW', processingError: null })
        .where(and(eq(media.id, mediaId), eq(media.status, 'PROCESSING')))
        .returning({ id: media.id });
      this.logger.log(`Media ${mediaId} processed${done.length ? '' : ' (status changed meanwhile)'}`);
      return 'processed';
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Marks a media FAILED with a message for the uploader. Only touches media that is still PROCESSING. */
  async markFailed(mediaId: string, message: string): Promise<void> {
    await this.db
      .update(media)
      .set({ status: 'FAILED', processingError: message.slice(0, 500) })
      .where(and(eq(media.id, mediaId), eq(media.status, 'PROCESSING')));
  }

  // ---------- 1. Probe ----------

  private async probeVideo(file: string): Promise<Probed> {
    let probe;
    try {
      probe = await ffprobe(file);
    } catch (err) {
      this.logger.warn(`ffprobe failed: ${(err as Error).message}`);
      throw new PermanentProcessingError('the file looks damaged or is not a video we can read.');
    }
    const video = readVideoProbe(probe);
    if (!video) throw new PermanentProcessingError('we could not find a video track in this file.');
    if (video.width * video.height > MAX_VIDEO_PIXELS) {
      throw new PermanentProcessingError('videos can be at most 4K (3840 × 2160).');
    }
    if (video.durationSec !== null && video.durationSec > this.config.maxVideoDurationSec) {
      const minutes = Math.floor(this.config.maxVideoDurationSec / 60);
      throw new PermanentProcessingError(`videos can be at most ${minutes} minutes long.`);
    }
    return {
      durationSec: video.durationSec,
      width: video.width,
      height: video.height,
      fileMetadata: video.fileMetadata,
      details: {
        container: video.container,
        videoCodec: video.videoCodec,
        audioCodec: video.audioCodec,
        rotation: video.rotation,
        tags: video.tags,
      },
    };
  }

  private async probePhoto(file: string): Promise<Probed> {
    // Decompression-bomb guard first, from the header alone: nothing has been decoded yet.
    checkPhotoPixels(imageDimensions(await readHeader(file, HEADER_BYTES)));
    let width: number;
    let height: number;
    let rotation: number;
    try {
      const stream = (await ffprobe(file)).streams?.find((s) => s.codec_type === 'video');
      if (!stream?.width || !stream.height) throw new Error('no image stream');
      rotation = await firstFrameRotation(file);
      ({ width, height } = uprightSize(stream.width, stream.height, rotation));
    } catch (err) {
      this.logger.warn(`Photo probe failed: ${(err as Error).message}`);
      throw new PermanentProcessingError('the photo looks damaged or uses a format we cannot read yet.');
    }

    // EXIF is optional: many apps strip it. A broken EXIF block must not fail the upload.
    const exif = (await exifr
      .parse(file, { tiff: true, exif: true, gps: true, ifd1: false, xmp: false, icc: false, iptc: false })
      .catch(() => null)) as ExifData | null;
    return {
      durationSec: null,
      width,
      height,
      fileMetadata: readExif(exif),
      details: {
        rotation,
        exif: exif
          ? {
              Make: exif.Make ?? null,
              Model: exif.Model ?? null,
              LensModel: exif.LensModel ?? null,
              Software: exif.Software ?? null,
              DateTimeOriginal: exif.DateTimeOriginal ?? null,
              OffsetTimeOriginal: exif.OffsetTimeOriginal ?? null,
              Orientation: exif.Orientation ?? null,
            }
          : null,
      },
    };
  }

  // ---------- 2. Previews ----------

  private async makePreviews(row: MediaRow, original: string, probed: Probed, workDir: string) {
    const thumbSize = fitWithin(probed.width, probed.height, THUMBNAIL.long, THUMBNAIL.short);
    const thumbFile = path.join(workDir, 'thumb.jpg');
    const thumbWatermark = await makeWatermark(workDir, thumbSize.width, thumbSize.height, { name: 'thumb-mark' });

    let previewKey: string;
    let hlsKeyHex: string | null = null;

    if (row.type === 'VIDEO') {
      // A fresh random AES-128 key per video. It is stored in the database (hls_key_hex),
      // never next to the segments, and served only through the token-checked key route.
      const key = randomBytes(16);
      const mezzanine = await this.encodeMezzanineFile(original, probed, workDir);
      const hlsOut = await this.segmentGenericHls(mezzanine, key, workDir);
      // Remove leftovers of an earlier attempt (it may have produced more segments),
      // and any per-newsroom renditions of an older preview.
      await this.storage.deletePrefix(storageKeys.hlsDir(row.id));
      await this.storage.deletePrefix(previewKeys.viewerRoot(row.id));
      await this.storage.putFile(previewKeys.mezzanine(row.id), mezzanine, 'video/mp4');
      await this.storage.putDirectory(storageKeys.hlsDir(row.id), hlsOut, hlsContentType);
      previewKey = storageKeys.hlsDir(row.id);
      hlsKeyHex = key.toString('hex');

      // Thumbnail from 1 s in (the first frame is often black), or the middle of very short clips.
      const at = probed.durationSec ? Math.min(1, probed.durationSec / 2) : 0;
      await renderWatermarkedJpeg({ input: original, watermark: thumbWatermark, output: thumbFile, ...thumbSize, atSecond: at });
    } else {
      const size = fitWithin(probed.width, probed.height, PHOTO_PREVIEW.long, PHOTO_PREVIEW.short);
      const watermark = await makeWatermark(workDir, size.width, size.height, { name: 'preview-mark' });
      const previewFile = path.join(workDir, 'preview.jpg');
      // No `orient` filters: FFmpeg already applies the EXIF rotation when decoding.
      await renderWatermarkedJpeg({ input: original, watermark, output: previewFile, ...size });
      await this.storage.deletePrefix(previewKeys.viewerRoot(row.id));
      await this.storage.putFile(storageKeys.previewImage(row.id), previewFile, 'image/jpeg');
      previewKey = storageKeys.previewImage(row.id);
      await renderWatermarkedJpeg({ input: original, watermark: thumbWatermark, output: thumbFile, ...thumbSize });
    }
    await this.storage.putFile(storageKeys.thumbnail(row.id), thumbFile, 'image/jpeg');

    // Recorded only after every file is in storage, so "previewKey is set" means "the preview works".
    await this.db
      .update(media)
      .set({
        previewKey,
        thumbKey: storageKeys.thumbnail(row.id),
        hlsKeyHex,
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
      })
      .where(eq(media.id, row.id));
  }

  /** The capped, scaled, generically marked private MP4 that every video rendition is cut from. */
  private async encodeMezzanineFile(original: string, probed: Pick<Probed, 'durationSec' | 'width' | 'height'>, workDir: string) {
    const plan = videoPreviewPlan(probed.durationSec, this.config.previewMaxSeconds);
    const size = fitWithin(probed.width, probed.height, plan.size.long, plan.size.short);
    const watermark = await makeWatermark(workDir, size.width, size.height, { ...plan.mark, name: 'preview-mark' });
    const output = path.join(workDir, 'mezzanine.mp4');
    await encodeMezzanine({ input: original, watermark, ...size, maxSeconds: plan.seconds, output });
    return output;
  }

  private async segmentGenericHls(mezzanine: string, key: Buffer, workDir: string): Promise<string> {
    const keyFile = path.join(workDir, 'hls.key');
    await writeFile(keyFile, key);
    const outDir = path.join(workDir, 'hls');
    await mkdir(outDir);
    await segmentHls({ input: mezzanine, keyFile, workDir, outDir });
    await rm(keyFile, { force: true });
    return outDir;
  }

  // ---------- 2b. Per-newsroom preview renditions (H4) ----------

  /**
   * Burns "ORGANISATION · VIEWER-ID" into the pixels of one newsroom's copy of the
   * preview, so a screen recording or a ripped stream names who leaked it. Rendered
   * on the first view and cached in storage; see PreviewRenderProcessor.
   * Returns false when there is nothing to render (media gone, not a channel...).
   */
  async renderViewerPreview(mediaId: string, viewerId: string): Promise<boolean> {
    const row = await this.db.query.media.findFirst({ where: eq(media.id, mediaId) });
    const [viewer] = await this.db
      .select({ name: users.name, role: users.role, organization: channelProfiles.organization })
      .from(users)
      .leftJoin(channelProfiles, eq(channelProfiles.userId, users.id))
      .where(eq(users.id, viewerId))
      .limit(1);
    if (!row || !viewer || row.status === 'REMOVED' || !row.previewKey) return false;
    const text = viewerMarkText(viewer.organization ?? viewer.name, viewerId);

    const workDir = await mkdtemp(path.join(tmpdir(), `firstframe-render-${mediaId}-`));
    try {
      if (row.type === 'PHOTO') {
        const base = path.join(workDir, 'preview.jpg');
        await this.storage.downloadTo(storageKeys.previewImage(row.id), base);
        const size = await frameSize(base);
        const mark = await makeWatermark(workDir, size.width, size.height, { ...VIEWER_MARK, text, angleDeg: -25, name: 'viewer' });
        const output = path.join(workDir, 'image.jpg');
        await renderWatermarkedJpeg({ input: base, watermark: mark, output, ...size });
        await this.storage.putFile(previewKeys.viewerImage(row.id, viewerId), output, 'image/jpeg');
        return true;
      }

      const key = Buffer.from(row.hlsKeyHex ?? '', 'hex');
      if (key.length !== 16) return false;
      const mezzanine = await this.loadOrMakeMezzanine(row, workDir);
      const size = await frameSize(mezzanine);
      const plan = videoPreviewPlan(row.durationSec, this.config.previewMaxSeconds);
      const mark = await makeWatermark(workDir, size.width, size.height, { ...VIEWER_MARK, text, angleDeg: -25, name: 'viewer' });
      const keyFile = path.join(workDir, 'hls.key');
      await writeFile(keyFile, key);
      const outDir = path.join(workDir, 'hls');
      await mkdir(outDir);
      const started = Date.now();
      await renderViewerHls({ input: mezzanine, overlay: mark, maxrateKbps: plan.viewerMaxrateKbps, keyFile, workDir, outDir });
      await rm(keyFile, { force: true });
      const dir = previewKeys.viewerDir(row.id, viewerId);
      await this.storage.deletePrefix(dir);
      // The playlist last: its presence is what tells the API the rendition is ready.
      const names = (await readdir(outDir)).sort((a, b) => Number(a === 'index.m3u8') - Number(b === 'index.m3u8'));
      for (const name of names) await this.storage.putFile(`${dir}/${name}`, path.join(outDir, name), hlsContentType(name));
      this.logger.log(`Rendered preview of ${row.id} for viewer ${viewerId} in ${Date.now() - started} ms`);
      return true;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Media processed before mezzanines existed get one now, with today's preview caps. */
  private async loadOrMakeMezzanine(row: MediaRow, workDir: string): Promise<string> {
    const file = path.join(workDir, 'mezzanine.mp4');
    try {
      await this.storage.downloadTo(previewKeys.mezzanine(row.id), file);
      return file;
    } catch {
      const original = path.join(workDir, `original${path.extname(row.originalKey)}`);
      await this.storage.downloadTo(row.originalKey, original);
      const probed = await this.probeVideo(original);
      const made = await this.encodeMezzanineFile(original, probed, workDir);
      await this.storage.putFile(previewKeys.mezzanine(row.id), made, 'video/mp4');
      return made;
    }
  }

  // ---------- 3. Verify ----------

  private async verify(row: MediaRow, original: string, probed: Probed, workDir: string, opts: ProcessOptions) {
    const framesDir = path.join(workDir, 'frames');
    await mkdir(framesDir);
    let frames: string[];
    if (row.type === 'VIDEO') {
      const span = probed.durationSec ?? MAX_VERIFIER_FRAMES;
      frames = await sampleVideoFrames({
        input: original,
        outDir: framesDir,
        everySeconds: Math.max(1, span / MAX_VERIFIER_FRAMES),
        maxFrames: MAX_VERIFIER_FRAMES,
      });
    } else {
      const frame = path.join(framesDir, 'frame_01.jpg');
      await photoFrame({ input: original, output: frame, orient: [], maxSide: 1024 });
      frames = [frame];
    }

    let result: VerifierResult | null = null;
    let verifierError: string | null = null;
    try {
      result = await this.verifier.analyze({
        mediaType: row.type,
        frames,
        original: { path: original, mime: row.mimeType, sizeBytes: (await stat(original)).size },
      });
    } catch (err) {
      if (!(err instanceof VerifierUnavailableError)) throw err;
      // Retry the whole job later (previews are already saved, so that is cheap)...
      if (err.retryable && !opts.finalAttempt) throw err;
      // ...but never block an upload forever on the verifier: record it and let a human decide.
      verifierError = err.message;
      this.logger.warn(`Verifier unavailable for ${row.id}: ${err.message}. Continuing without it.`);
    }

    const phashes = result?.phashes.filter(isInformativePhash) ?? [];
    const duplicate = phashes.length ? await this.findDuplicate(row, phashes) : null;

    const risk = assessRisk({
      verifierAvailable: result !== null,
      ai: result ? result.ai : { available: false, score: null, model: null },
      c2pa: result ? result.c2pa : { status: 'unsupported', issuer: null },
      duplicateOfId: duplicate?.mediaId ?? null,
      claimed: { capturedAt: row.capturedAt, latitude: row.latitude, longitude: row.longitude },
      fileMetadata: probed.fileMetadata,
    });

    // Full metadata: shown to admins only (toVerificationView hides it from everyone else).
    const metadata: Record<string, unknown> = {
      file: {
        type: row.type,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        ...probed.details,
      },
      capture: {
        capturedAt: probed.fileMetadata.capturedAt?.toISOString() ?? null,
        latitude: probed.fileMetadata.latitude,
        longitude: probed.fileMetadata.longitude,
        device: probed.fileMetadata.device,
        encoder: probed.fileMetadata.encoder,
      },
      verifier: result
        ? {
            available: true,
            framesSent: frames.length,
            framesScored: result.ai.framesScored,
            frameScores: result.ai.frameScores,
            c2paClaimGenerator: result.c2pa.claimGenerator,
          }
        : { available: false, error: verifierError, framesSent: frames.length },
      duplicate: duplicate ? { mediaId: duplicate.mediaId, distance: duplicate.distance } : null,
    };

    const values = {
      mediaId: row.id,
      aiScore: result?.ai.available ? result.ai.score : null,
      aiModel: result?.ai.available ? result.ai.model : null,
      framesScored: result?.ai.framesScored ?? 0,
      c2paStatus: result?.c2pa.status ?? 'unsupported',
      c2paIssuer: result?.c2pa.issuer ?? null,
      metadata,
      phashes: result?.phashes.filter((h) => /^[0-9a-f]{16}$/i.test(h)) ?? [],
      duplicateOfId: duplicate?.mediaId ?? null,
      signals: risk.signals,
      riskLevel: risk.riskLevel,
    };
    // Upsert: a retried job overwrites instead of failing on the primary key.
    await this.db
      .insert(verifications)
      .values(values)
      .onConflictDoUpdate({ target: verifications.mediaId, set: { ...values, mediaId: undefined } });
  }

  // ---------- 3b. Delivery copy (H3) ----------

  /**
   * Builds the buyer's copy of a media item that has already been processed
   * (job `prepare-delivery`: backfill for older uploads, or a download that found none).
   */
  async prepareDelivery(mediaId: string): Promise<'prepared' | 'skipped'> {
    const row = await this.db.query.media.findFirst({ where: eq(media.id, mediaId) });
    if (!row || row.status === 'PROCESSING' || row.status === 'FAILED') return 'skipped';
    const verification = await this.db.query.verifications.findFirst({ where: eq(verifications.mediaId, mediaId) });
    if (!verification || readDeliveryInfo(verification.metadata)) return 'skipped';
    const workDir = await mkdtemp(path.join(tmpdir(), `firstframe-delivery-${mediaId}-`));
    try {
      const original = path.join(workDir, `original${path.extname(row.originalKey)}`);
      await this.storage.downloadTo(row.originalKey, original);
      await this.makeDelivery(row, original, workDir);
      return 'prepared';
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Writes the delivery copy (no GPS, device, owner name...) next to the original and
   * records its checksum in the verification's metadata. The copy is checked after it
   * is made: if any identifying tag survived, it is refused rather than sold.
   */
  private async makeDelivery(row: MediaRow, original: string, workDir: string): Promise<DeliveryInfo> {
    const output = path.join(workDir, `delivery${deliveryExt(row)}`);
    const mimeType = deliveryMimeType(row.mimeType);

    if (row.type === 'VIDEO') {
      const probe = await ffprobe(original);
      const creation = probe.format?.tags?.creation_time;
      await stripVideoMetadata({
        input: original,
        output,
        creationTime: creation && !Number.isNaN(Date.parse(creation)) ? new Date(creation).toISOString() : null,
        mp4Family: row.mimeType !== 'video/webm',
      });
      assertCleanVideo(await ffprobe(output));
    } else {
      const format = imageFormatOf(row.mimeType);
      if (format) {
        const [orientation, raw] = await Promise.all([
          exifr.orientation(original).catch(() => undefined),
          exifr.parse(original, { pick: ['DateTimeOriginal'], reviveValues: false }).catch(() => undefined) as Promise<
            { DateTimeOriginal?: string } | undefined
          >,
        ]);
        try {
          const cleaned = stripImageMetadata(format, await readFile(original), {
            orientation: orientation ?? null,
            dateTimeOriginal: raw?.DateTimeOriginal ?? null,
          });
          await writeFile(output, cleaned);
        } catch (err) {
          if (!(err instanceof ImageFormatError)) throw err;
          throw new PermanentProcessingError('the photo file is damaged, so we cannot prepare it for sale.');
        }
      } else {
        await reencodePhotoAsJpeg(original, output);
      }
      await assertCleanPhoto(output, format);
    }

    const info: DeliveryInfo = {
      key: deliveryKey(row),
      sha256: await sha256File(output),
      sizeBytes: (await stat(output)).size,
      mimeType,
      createdAt: new Date().toISOString(),
    };
    await this.storage.putFile(info.key, output, mimeType);
    await this.db
      .update(verifications)
      .set({ metadata: sql`${verifications.metadata} || ${JSON.stringify({ delivery: info })}::jsonb` })
      .where(eq(verifications.mediaId, row.id));
    return info;
  }

  /**
   * Finds the closest earlier upload whose frames look like ours (pHash Hamming
   * distance ≤ 8 bits on any pair of frames). Scans verifications in batches of
   * 1000 (keyset pagination on id), so memory stays flat however many uploads exist.
   * See docs/learning/media-and-processing.md for how this would scale.
   */
  async findDuplicate(row: Pick<MediaRow, 'id'>, hashes: string[]): Promise<{ mediaId: string; distance: number } | null> {
    let best: { mediaId: string; distance: number; createdAt: Date } | null = null;
    let cursor: string | null = null;
    for (;;) {
      const batch: { id: string; createdAt: Date; phashes: string[] }[] = await this.db
        .select({ id: media.id, createdAt: media.createdAt, phashes: verifications.phashes })
        .from(verifications)
        .innerJoin(media, eq(media.id, verifications.mediaId))
        .where(
          and(
            ne(media.id, row.id),
            // Only uploads that came before this one: the earlier upload is the original.
            // Compared in SQL, because JavaScript dates drop Postgres' microseconds.
            sql`${media.createdAt} < (SELECT m.created_at FROM media m WHERE m.id = ${row.id})`,
            sql`cardinality(${verifications.phashes}) > 0`,
            cursor ? gt(media.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(media.id))
        .limit(DUPLICATE_SCAN_BATCH);

      for (const candidate of batch) {
        const distance = minDistance(hashes, candidate.phashes.filter(isInformativePhash));
        if (distance === null || distance > DUPLICATE_MAX_DISTANCE) continue;
        // Closest match wins; on a tie, the earliest upload (the likely original).
        if (!best || distance < best.distance || (distance === best.distance && candidate.createdAt < best.createdAt)) {
          best = { mediaId: candidate.id, distance, createdAt: candidate.createdAt };
        }
      }
      if (batch.length < DUPLICATE_SCAN_BATCH) break;
      cursor = batch[batch.length - 1].id;
    }
    return best ? { mediaId: best.mediaId, distance: best.distance } : null;
  }
}

/** Has an earlier attempt already stored the preview and thumbnail? */
function hasPreviewOutputs(row: MediaRow): boolean {
  if (!row.previewKey || !row.thumbKey) return false;
  return row.type === 'PHOTO' || !!row.hlsKeyHex;
}

function hlsContentType(name: string): string {
  return name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
}

/** Width × height of the first video stream of a file we made ourselves (preview, mezzanine). */
async function frameSize(file: string): Promise<{ width: number; height: number }> {
  const stream = (await ffprobe(file)).streams?.find((s) => s.codec_type === 'video');
  if (!stream?.width || !stream.height) throw new Error(`no video stream in ${path.basename(file)}`);
  return { width: stream.width, height: stream.height };
}

async function readHeader(file: string, bytes: number): Promise<Buffer> {
  const handle = await openFile(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Refuses photos whose header declares more than MAX_PHOTO_PIXELS (or a zero size). */
export function checkPhotoPixels(size: { width: number; height: number } | null): void {
  if (!size) return; // unknown header (HEIC): FFmpeg's max_pixels still guards the decode
  if (size.width <= 0 || size.height <= 0) {
    throw new PermanentProcessingError('the photo looks damaged or uses a format we cannot read yet.');
  }
  if (size.width * size.height > MAX_PHOTO_PIXELS) {
    throw new PermanentProcessingError(`photos can be at most ${MAX_PHOTO_PIXELS / 1_000_000} megapixels.`);
  }
}

/** Every tag left on the delivery video must be in ALLOWED_VIDEO_TAGS, and only audio/video streams may remain. */
export function assertCleanVideo(probe: Awaited<ReturnType<typeof ffprobe>>): void {
  const tags = [probe.format?.tags ?? {}, ...(probe.streams ?? []).map((st) => st.tags ?? {})];
  const leftover = tags.flatMap((t) => Object.keys(t)).filter((k) => !ALLOWED_VIDEO_TAGS.has(k.toLowerCase()));
  const otherStreams = (probe.streams ?? []).filter((st) => st.codec_type !== 'video' && st.codec_type !== 'audio');
  if (leftover.length || otherStreams.length) {
    throw new Error(`delivery copy still has metadata: ${[...leftover, ...otherStreams.map((st) => st.codec_type)].join(', ')}`);
  }
}

/** Re-reads the delivery photo: only orientation and capture time may be left. */
async function assertCleanPhoto(file: string, format: ReturnType<typeof imageFormatOf>): Promise<void> {
  if (format === 'webp') return; // exifr cannot read WebP; stripWebp keeps only image chunks (see its tests)
  const found = (await exifr
    .parse(file, { tiff: true, exif: true, gps: true, ifd1: true, xmp: true, iptc: true, icc: false, makerNote: true, userComment: true })
    .catch(() => null)) as Record<string, unknown> | null;
  const leftover = Object.keys(found ?? {}).filter((k) => !ALLOWED_PHOTO_TAGS.has(k));
  if (leftover.length) throw new Error(`delivery copy still has metadata: ${leftover.join(', ')}`);
}
