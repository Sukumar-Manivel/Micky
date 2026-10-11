// The "delivery copy": what a buyer downloads after paying.
//
// The untouched original can carry the witness's name (EXIF Artist/Copyright),
// home location (GPS), phone model and serial number. It stays in storage for
// admins and as evidence; buyers get a copy with that metadata removed, made by the
// worker (MediaProcessingService.prepareDelivery) at a key derived from the original's:
//   originals/<id>/source.mp4  →  originals/<id>/delivery.mp4
// Facts about the copy (its SHA-256, size, type) are kept in the verification's
// admin-only metadata JSON under `delivery`, so no schema change was needed.
import path from 'node:path';

export interface DeliveryInfo {
  key: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

/** HEIC cannot be cleaned without a re-encode, so it is delivered as JPEG; everything else keeps its format. */
export function deliveryMimeType(originalMime: string): string {
  return originalMime === 'image/heic' ? 'image/jpeg' : originalMime;
}

/** Extension of the delivery copy (lower case, with the dot). */
export function deliveryExt(row: { originalKey: string; mimeType: string }): string {
  if (row.mimeType === 'image/heic') return '.jpg';
  const ext = path.extname(row.originalKey).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/** Storage key of the delivery copy, next to the original. */
export function deliveryKey(row: { id: string; originalKey: string; mimeType: string }): string {
  return `${path.posix.dirname(row.originalKey)}/delivery${deliveryExt(row)}`;
}

/** Reads `metadata.delivery` written by the worker; null if missing or malformed. */
export function readDeliveryInfo(metadata: Record<string, unknown> | null | undefined): DeliveryInfo | null {
  const d = metadata?.delivery as Partial<DeliveryInfo> | undefined;
  if (!d || typeof d.key !== 'string' || typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) return null;
  if (typeof d.sizeBytes !== 'number' || typeof d.mimeType !== 'string') return null;
  return { key: d.key, sha256: d.sha256, sizeBytes: d.sizeBytes, mimeType: d.mimeType, createdAt: String(d.createdAt ?? '') };
}

/**
 * Video tags the delivery copy may still have. Anything else (location, make, model,
 * artist, comment, com.apple.*, software...) means stripping failed, and the copy is refused.
 */
export const ALLOWED_VIDEO_TAGS = new Set([
  'major_brand',
  'minor_version',
  'compatible_brands',
  'creation_time',
  'encoder', // muxer name written by FFmpeg/WebM ("Lavf..."), not the phone's
  'handler_name', // FFmpeg's default "VideoHandler"/"SoundHandler" (the original's are not copied)
  'vendor_id',
  'language',
  'duration', // WebM per-stream duration
]);

/**
 * Photo tags the delivery copy may still have (after exifr translates the keys):
 * orientation and capture time, plus the PNG header fields exifr always reports.
 */
export const ALLOWED_PHOTO_TAGS = new Set([
  'Orientation',
  'DateTimeOriginal',
  'ImageWidth',
  'ImageHeight',
  'BitDepth',
  'ColorType',
  'Compression',
  'Filter',
  'Interlace',
]);
