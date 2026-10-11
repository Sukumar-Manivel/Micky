// Detects what an uploaded file really is by looking at its first bytes
// ("magic bytes" / file signature).
//
// Never trust the file name or the Content-Type the browser sends: both are
// chosen by the client. A file called "video.mp4" can be an HTML page or an
// executable. The first few bytes of real media formats are fixed by their
// specifications, so they are a much better (still not perfect) check.
// The worker later runs ffprobe, which fully parses the file.

export type MediaKind = 'VIDEO' | 'PHOTO';

export interface DetectedFileType {
  kind: MediaKind;
  /** The MIME type we store and serve, decided by us, not by the client. */
  mime: string;
  /** File extension (with the dot) used for the stored original. */
  ext: string;
}

/** How many bytes of the file `detectFileType` needs to see. */
export const SNIFF_BYTES = 32;

// ISO base media files (mp4, mov, heic) start with a box: 4 bytes size, then "ftyp",
// then a 4-character "major brand" that says which flavour the file is.
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP',
  'dash', 'mmp4', 'MSNV', 'f4v ', '3gp4', '3gp5', '3gp6', '3g2a',
]);
const MOV_BRANDS = new Set(['qt  ']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1']);

const VIDEO_MP4: DetectedFileType = { kind: 'VIDEO', mime: 'video/mp4', ext: '.mp4' };
const VIDEO_MOV: DetectedFileType = { kind: 'VIDEO', mime: 'video/quicktime', ext: '.mov' };
const VIDEO_WEBM: DetectedFileType = { kind: 'VIDEO', mime: 'video/webm', ext: '.webm' };
const PHOTO_JPEG: DetectedFileType = { kind: 'PHOTO', mime: 'image/jpeg', ext: '.jpg' };
const PHOTO_PNG: DetectedFileType = { kind: 'PHOTO', mime: 'image/png', ext: '.png' };
const PHOTO_WEBP: DetectedFileType = { kind: 'PHOTO', mime: 'image/webp', ext: '.webp' };
const PHOTO_HEIC: DetectedFileType = { kind: 'PHOTO', mime: 'image/heic', ext: '.heic' };

/**
 * Returns the media type of a file from its first bytes, or null if it is not
 * one of the formats we accept (mp4, mov, webm, jpeg, png, webp, heic).
 */
export function detectFileType(head: Uint8Array): DetectedFileType | null {
  const ascii = (start: number, end: number) => Buffer.from(head.subarray(start, end)).toString('latin1');
  const startsWith = (bytes: number[]) => bytes.every((b, i) => head[i] === b);

  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (MP4_BRANDS.has(brand)) return VIDEO_MP4;
    if (MOV_BRANDS.has(brand)) return VIDEO_MOV;
    if (HEIC_BRANDS.has(brand)) return PHOTO_HEIC;
    return null; // e.g. AVIF or an unknown brand
  }
  // WebM (and Matroska) files start with the EBML header 1A 45 DF A3.
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return VIDEO_WEBM;
  // JPEG: FF D8 (start of image) followed by FF (the next marker).
  if (startsWith([0xff, 0xd8, 0xff])) return PHOTO_JPEG;
  // PNG: \x89 P N G
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return PHOTO_PNG;
  // WebP: "RIFF" <4-byte size> "WEBP"
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return PHOTO_WEBP;

  return null;
}
