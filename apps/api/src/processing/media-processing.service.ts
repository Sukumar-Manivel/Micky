import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import exifr from 'exifr';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { media, verifications } from '../db/schema.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { StorageService, storageKeys } from '../storage/storage.service.js';
import { PermanentProcessingError } from './errors.js';
import {
  encodeHlsPreview,
  ffprobe,
  firstFrameRotation,
  makeWatermark,
  photoFrame,
  renderWatermarkedJpeg,
  sampleVideoFrames,
} from './ffmpeg.js';
import { type ExifData, type FileMetadata, fitWithin, readExif, readVideoProbe, uprightSize } from './media-metadata.js';
import { DUPLICATE_MAX_DISTANCE, isInformativePhash, minDistance } from './phash.js';
import { assessRisk } from './risk.js';
import { VerifierClient, type VerifierResult, VerifierUnavailableError } from './verifier.client.js';

type MediaRow = typeof media.$inferSelect;

/** Preview sizes. Video: 480p, the most a channel needs to judge footage, too low to broadcast. */
const VIDEO_PREVIEW = { long: 854, short: 480 };
const PHOTO_PREVIEW = { long: 1280, short: 1280 };
const THUMBNAIL = { long: 480, short: 480 };
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

      const existing = await this.db.query.verifications.findFirst({ where: eq(verifications.mediaId, mediaId) });
      if (!existing) await this.verify(row, original, probed, workDir, opts);

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
    const thumbWatermark = await makeWatermark(workDir, thumbSize.width, thumbSize.height);

    let previewKey: string;
    let hlsKeyHex: string | null = null;

    if (row.type === 'VIDEO') {
      const size = fitWithin(probed.width, probed.height, VIDEO_PREVIEW.long, VIDEO_PREVIEW.short);
      const watermark = await makeWatermark(workDir, size.width, size.height);
      // A fresh random AES-128 key per video. It is stored in the database (hls_key_hex),
      // never next to the segments, and served only through the token-checked key route.
      const key = randomBytes(16);
      const keyFile = path.join(workDir, 'hls.key');
      await writeFile(keyFile, key);
      const hlsOut = path.join(workDir, 'hls');
      await mkdir(hlsOut);
      await encodeHlsPreview({
        input: original,
        watermark,
        width: size.width,
        height: size.height,
        maxSeconds: this.config.previewMaxSeconds,
        keyFile,
        workDir,
        outDir: hlsOut,
      });
      // Remove leftovers of an earlier attempt (it may have produced more segments).
      await this.storage.deletePrefix(storageKeys.hlsDir(row.id));
      await this.storage.putDirectory(storageKeys.hlsDir(row.id), hlsOut, (name) =>
        name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      );
      previewKey = storageKeys.hlsDir(row.id);
      hlsKeyHex = key.toString('hex');

      // Thumbnail from 1 s in (the first frame is often black), or the middle of very short clips.
      const at = probed.durationSec ? Math.min(1, probed.durationSec / 2) : 0;
      await renderWatermarkedJpeg({ input: original, watermark: thumbWatermark, output: thumbFile, ...thumbSize, atSecond: at });
    } else {
      const size = fitWithin(probed.width, probed.height, PHOTO_PREVIEW.long, PHOTO_PREVIEW.short);
      const watermark = await makeWatermark(workDir, size.width, size.height);
      const previewFile = path.join(workDir, 'preview.jpg');
      // No `orient` filters: FFmpeg already applies the EXIF rotation when decoding.
      await renderWatermarkedJpeg({ input: original, watermark, output: previewFile, ...size });
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
