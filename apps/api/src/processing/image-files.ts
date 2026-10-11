// Pure-JavaScript helpers for photo files, used before FFmpeg ever touches them:
//
// 1. `imageDimensions` reads width × height from the header (a few hundred bytes),
//    so the API can refuse a decompression bomb (a 1 MB PNG that declares
//    16000 × 16000 pixels = 1 GB of RAM when decoded) without decoding anything.
// 2. `stripImageMetadata` makes the buyer's "delivery copy" of a photo: the same
//    compressed image data, byte for byte (no re-encode, no quality loss), with every
//    metadata block removed except the ones needed to show the picture correctly.
//
// Why not exiftool? It is not in our image, and a whitelist of what to KEEP is safer
// than a blacklist of what to remove: a new phone that invents a new metadata block
// is dropped by default.
import { crc32 } from 'node:zlib';

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export class ImageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageFormatError';
  }
}

export function imageFormatOf(mime: string): ImageFormat | null {
  if (mime === 'image/jpeg') return 'jpeg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return null;
}

// ---------- Dimensions from the header ----------

/**
 * Width and height declared by a JPEG, PNG or WebP header, or null if the format
 * is not recognised (HEIC: FFmpeg's `max_pixels` guard still applies later).
 */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return jpegDimensions(buf);
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** Walks JPEG segments until a SOFn (start of frame) marker, which holds the size. */
function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const length = buf.readUInt16BE(pos + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (pos + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    if (marker === 0xda) return null; // image data started before any frame header: malformed
    pos += 2 + length;
  }
  return null;
}

// ---------- Minimal EXIF (orientation + capture time only) ----------

/**
 * A tiny little-endian TIFF/EXIF block with only Orientation (when it is not 1)
 * and DateTimeOriginal (when known). Returns null when there is nothing to write.
 * Orientation must survive: without it a portrait phone photo shows sideways.
 */
export function buildMinimalExif(opts: { orientation?: number | null; dateTimeOriginal?: string | null }): Buffer | null {
  const orientation = opts.orientation && opts.orientation >= 2 && opts.orientation <= 8 ? opts.orientation : null;
  const date = opts.dateTimeOriginal && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(opts.dateTimeOriginal)
    ? opts.dateTimeOriginal
    : null;
  if (!orientation && !date) return null;

  const ifd0Entries = (orientation ? 1 : 0) + (date ? 1 : 0);
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  const exifIfdOffset = 8 + ifd0Size;
  const exifIfdSize = date ? 2 + 12 + 4 : 0;
  const dateOffset = exifIfdOffset + exifIfdSize;
  const out = Buffer.alloc(dateOffset + (date ? 20 : 0));

  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  let p = 8;
  out.writeUInt16LE(ifd0Entries, p);
  p += 2;
  // Entries must be sorted by tag: 0x0112 (Orientation) < 0x8769 (Exif IFD pointer).
  if (orientation) {
    out.writeUInt16LE(0x0112, p); // Orientation
    out.writeUInt16LE(3, p + 2); // SHORT
    out.writeUInt32LE(1, p + 4);
    out.writeUInt16LE(orientation, p + 8);
    p += 12;
  }
  if (date) {
    out.writeUInt16LE(0x8769, p); // ExifIFDPointer
    out.writeUInt16LE(4, p + 2); // LONG
    out.writeUInt32LE(1, p + 4);
    out.writeUInt32LE(exifIfdOffset, p + 8);
    p += 12;
  }
  out.writeUInt32LE(0, p); // no next IFD (so no thumbnail IFD1)
  if (date) {
    p = exifIfdOffset;
    out.writeUInt16LE(1, p);
    out.writeUInt16LE(0x9003, p + 2); // DateTimeOriginal
    out.writeUInt16LE(2, p + 4); // ASCII
    out.writeUInt32LE(20, p + 6);
    out.writeUInt32LE(dateOffset, p + 10);
    out.writeUInt32LE(0, p + 14);
    out.write(`${date}\0`, dateOffset, 'latin1');
  }
  return out;
}

// ---------- Stripping ----------

export interface KeptFacts {
  orientation?: number | null;
  dateTimeOriginal?: string | null;
}

/** Returns a copy of the image without identifying metadata. Throws ImageFormatError on malformed input. */
export function stripImageMetadata(format: ImageFormat, input: Buffer, keep: KeptFacts): Buffer {
  const exif = buildMinimalExif(keep);
  switch (format) {
    case 'jpeg':
      return stripJpeg(input, exif);
    case 'png':
      return stripPng(input, exif);
    case 'webp':
      return stripWebp(input, exif);
  }
}

/**
 * JPEG = a list of segments (FF xx + length + data); after SOS comes the
 * entropy-coded image data. Kept: JFIF (APP0), ICC colour profile (APP2), Adobe
 * colour transform (APP14) and everything the decoder needs (tables, frame and
 * scan headers, image data). Dropped: EXIF/XMP (APP1: GPS, make, model, serial
 * numbers, owner name, MakerNotes, thumbnails), MPF and FlashPix (APP2: embedded
 * second pictures), APP3–APP13 (IPTC, Photoshop, vendor blocks), APP15, comments,
 * JFXX thumbnails, and anything after the end-of-image marker (some phones append
 * depth maps or whole extra JPEGs with their own EXIF there).
 */
function stripJpeg(buf: Buffer, exif: Buffer | null): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new ImageFormatError('not a JPEG');
  const out: Buffer[] = [buf.subarray(0, 2)];
  let exifWritten = !exif;
  const writeExif = () => {
    if (exifWritten || !exif) return;
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif]);
    const header = Buffer.from([0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(payload.length + 2, 2);
    out.push(header, payload);
    exifWritten = true;
  };

  let pos = 2;
  for (;;) {
    if (pos + 2 > buf.length) throw new ImageFormatError('JPEG ends without an end-of-image marker');
    if (buf[pos] !== 0xff) throw new ImageFormatError('malformed JPEG segment');
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd9) {
      writeExif();
      out.push(buf.subarray(pos, pos + 2));
      break; // drop everything after EOI
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > buf.length) throw new ImageFormatError('truncated JPEG segment');
    const end = pos + 2 + buf.readUInt16BE(pos + 2);
    if (end > buf.length) throw new ImageFormatError('truncated JPEG segment');
    const segment = buf.subarray(pos, end);
    const id = (len: number) => buf.toString('latin1', pos + 4, Math.min(end, pos + 4 + len));

    // Our EXIF block goes right after JFIF (or first, when there is no JFIF).
    if (marker !== 0xe0) writeExif();
    let keepSegment: boolean;
    if (marker === 0xe0) keepSegment = id(5) === 'JFIF\0';
    else if (marker === 0xe2) keepSegment = id(12) === 'ICC_PROFILE\0';
    else if (marker === 0xee) keepSegment = id(5) === 'Adobe';
    else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) keepSegment = false;
    else keepSegment = true;
    if (keepSegment) out.push(segment);
    pos = end;

    if (marker === 0xda) {
      // Entropy-coded data runs until a marker that is not a stuffed 00 or a restart marker.
      let i = pos;
      while (i + 1 < buf.length) {
        if (buf[i] === 0xff) {
          const next = buf[i + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        i++;
      }
      if (i + 1 >= buf.length) throw new ImageFormatError('JPEG image data is truncated');
      out.push(buf.subarray(pos, i));
      pos = i;
    }
  }
  return Buffer.concat(out);
}

/** PNG chunks needed to show the picture right; text, XMP (iTXt), eXIf, tIME and vendor chunks are dropped. */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'pHYs',
  'acTL', 'fcTL', 'fdAT', // animated PNG
]);

function stripPng(buf: Buffer, exif: Buffer | null): Buffer {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new ImageFormatError('not a PNG');
  const out: Buffer[] = [buf.subarray(0, 8)];
  let pos = 8;
  let ended = false;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > buf.length) throw new ImageFormatError('truncated PNG chunk');
    // eXIf must come before the first IDAT; only orientation/capture time is written.
    if (type === 'IDAT' && exif) {
      out.push(pngChunk('eXIf', exif));
      exif = null;
    }
    if (PNG_KEEP.has(type)) out.push(buf.subarray(pos, end));
    pos = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) throw new ImageFormatError('PNG ends without IEND');
  return Buffer.concat(out);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** WebP chunks needed to show the picture; EXIF and XMP chunks (and unknown ones) are dropped. */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function stripWebp(buf: Buffer, exif: Buffer | null): Buffer {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    throw new ImageFormatError('not a WebP');
  }
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let vp8x: Buffer | null = null;
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const type = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size % 2); // chunks are padded to an even size
    if (pos + 8 + size > riffEnd) throw new ImageFormatError('truncated WebP chunk');
    if (WEBP_KEEP.has(type)) {
      const chunk = Buffer.from(buf.subarray(pos, Math.min(end, riffEnd)));
      if (type === 'VP8X') vp8x = chunk;
      chunks.push(chunk);
    }
    pos = end;
  }
  if (vp8x) {
    // VP8X flags byte: 0x08 = has EXIF, 0x04 = has XMP.
    vp8x[8] &= ~0x0c;
    if (exif) {
      vp8x[8] |= 0x08;
      const head = Buffer.alloc(8);
      head.write('EXIF', 0, 'latin1');
      head.writeUInt32LE(exif.length, 4);
      chunks.push(head, exif, Buffer.alloc(exif.length % 2));
    }
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
