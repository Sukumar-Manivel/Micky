// Pure helpers that turn ffprobe / EXIF output into the facts the worker needs:
// upright dimensions, preview sizes, and "what does the file say about where and
// when it was captured". No I/O here, so everything is unit tested.
import type { FfprobeOutput, FfprobeStream } from './ffmpeg.js';

/** What the file says about its own capture (compared with the uploader's claims in risk.ts). */
export interface FileMetadata {
  capturedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  device: string | null;
  encoder: string | null;
}

export interface ProbedVideo {
  durationSec: number | null;
  /** Upright size (after applying the rotation flag phones write). */
  width: number;
  height: number;
  rotation: number;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  fileMetadata: FileMetadata;
  /** Container tags worth showing an admin (device, software, location...). */
  tags: Record<string, string>;
}

// ---------- Sizes ----------

/** Width/height as displayed: a 1920×1080 stream with a 90° rotation flag is shown as 1080×1920. */
export function uprightSize(width: number, height: number, rotation: number): { width: number; height: number } {
  const quarterTurns = Math.round(Math.abs(rotation) / 90) % 2;
  return quarterTurns === 1 ? { width: height, height: width } : { width, height };
}

/**
 * Scales (width, height) down, never up, so the long side is ≤ maxLong and the
 * short side ≤ maxShort, keeping the aspect ratio. Both results are even, which
 * H.264 with 4:2:0 chroma requires, and at least 2.
 *
 * fitWithin(1920, 1080, 854, 480) → 852×480 ("480p"); fitWithin(1080, 1920, 854, 480) → 480×852 (portrait).
 */
export function fitWithin(width: number, height: number, maxLong: number, maxShort: number) {
  const landscape = width >= height;
  const [long, short] = landscape ? [width, height] : [height, width];
  const scale = Math.min(1, maxLong / long, maxShort / short);
  const even = (n: number) => Math.max(2, Math.floor((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

// ---------- Video (ffprobe) ----------

/** Turns ffprobe's JSON into upright size, duration and capture metadata. Returns null if there is no video track. */
export function readVideoProbe(probe: FfprobeOutput): ProbedVideo | null {
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.width && s.height && !isAttachedPicture(s));
  if (!video?.width || !video.height) return null;
  const audio = streams.find((s) => s.codec_type === 'audio');

  const rotation = streamRotation(video);
  const size = uprightSize(video.width, video.height, rotation);
  const duration = positiveNumber(probe.format?.duration) ?? positiveNumber(video.duration);

  // Tags live on the container (format) and sometimes on the stream; container tags win.
  const tags = lowerKeys({ ...video.tags, ...probe.format?.tags });
  const location =
    parseIso6709(tags['com.apple.quicktime.location.iso6709']) ?? parseIso6709(tags['location']) ?? null;
  const make = tags['com.apple.quicktime.make'] ?? tags['com.android.manufacturer'] ?? tags['make'];
  const model = tags['com.apple.quicktime.model'] ?? tags['com.android.model'] ?? tags['model'];
  const capturedAt =
    parseDate(tags['com.apple.quicktime.creationdate']) ?? parseDate(tags['creation_time']) ?? null;

  return {
    durationSec: duration,
    width: size.width,
    height: size.height,
    rotation,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    container: probe.format?.format_name ?? null,
    fileMetadata: {
      capturedAt,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      device: joinDevice(make, model),
      encoder: tags['encoder'] ?? tags['com.apple.quicktime.software'] ?? tags['software'] ?? null,
    },
    tags: pickTags(tags),
  };
}

/** Rotation in degrees from the display matrix (newer FFmpeg) or the legacy "rotate" tag. */
export function streamRotation(stream: FfprobeStream): number {
  const fromSideData = stream.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  if (typeof fromSideData === 'number') return fromSideData;
  const tag = Number(stream.tags?.rotate);
  return Number.isFinite(tag) ? tag : 0;
}

/** Cover art in an mp4/mov shows up as a video stream; it is not the video. */
function isAttachedPicture(stream: FfprobeStream & { disposition?: { attached_pic?: number } }) {
  return stream.disposition?.attached_pic === 1;
}

/**
 * Parses an ISO 6709 location string as written by phones in video files,
 * e.g. "+10.0123+076.2673/" or "+10.0123+076.2673+012.500/". Returns null if invalid.
 */
export function parseIso6709(value: string | undefined): { latitude: number; longitude: number } | null {
  if (!value) return null;
  const match = /^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/.exec(value.trim());
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // (0, 0) is in the Atlantic; it means "no fix", not a real location.
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

// ---------- Photo (EXIF) ----------

/** The subset of exifr's output we use. */
export interface ExifData {
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
  OffsetTimeOriginal?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  Make?: unknown;
  Model?: unknown;
  Software?: unknown;
  Orientation?: unknown;
  LensModel?: unknown;
}

export function readExif(exif: ExifData | null | undefined): FileMetadata {
  if (!exif) return { capturedAt: null, latitude: null, longitude: null, device: null, encoder: null };
  const lat = typeof exif.latitude === 'number' && Number.isFinite(exif.latitude) ? exif.latitude : null;
  const lng = typeof exif.longitude === 'number' && Number.isFinite(exif.longitude) ? exif.longitude : null;
  const hasFix = lat !== null && lng !== null && !(lat === 0 && lng === 0);
  return {
    capturedAt: exifDate(exif.DateTimeOriginal, exif.OffsetTimeOriginal) ?? exifDate(exif.CreateDate, undefined),
    latitude: hasFix ? lat : null,
    longitude: hasFix ? lng : null,
    device: joinDevice(str(exif.Make), str(exif.Model)),
    encoder: str(exif.Software) ?? null,
  };
}

/**
 * EXIF dates are local wall-clock time without a zone ("2026:10:11 14:05:00").
 * exifr returns them as a Date in the server's zone. If the camera also wrote
 * OffsetTimeOriginal ("+05:30") we rebuild the exact instant; otherwise we keep
 * exifr's value, which can be off by the camera's UTC offset (well inside the
 * 24 h mismatch tolerance in risk.ts).
 */
function exifDate(value: unknown, offset: unknown): Date | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return parseDate(str(value));
  if (typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    const p = (n: number) => String(n).padStart(2, '0');
    const local = `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}T${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}${offset}`;
    return parseDate(local) ?? value;
  }
  return sane(value);
}

// ---------- Helpers ----------

/** Parses a date string. Rejects invalid dates and placeholder values like 1970-01-01 or 1904-01-01. */
export function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return sane(date);
}

function sane(date: Date): Date | null {
  if (Number.isNaN(date.getTime())) return null;
  // QuickTime's epoch is 1904 and Unix's is 1970: both appear when a camera has no clock set.
  if (date.getUTCFullYear() < 1990) return null;
  return date;
}

function positiveNumber(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function joinDevice(make: string | undefined, model: string | undefined): string | null {
  const m = make?.trim();
  const d = model?.trim();
  if (!m && !d) return null;
  if (m && d) return d.toLowerCase().startsWith(m.toLowerCase()) ? d : `${m} ${d}`;
  return (m ?? d)!;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function lowerKeys(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

/** Keeps only short, known-useful tags, so the stored metadata stays small. */
const USEFUL_TAG = /^(creation_time|encoder|location|make|model|software|major_brand|com\.apple\.quicktime\.|com\.android\.)/;
function pickTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags)
      .filter(([k, v]) => USEFUL_TAG.test(k) && v.length <= 200)
      .slice(0, 30),
  );
}
