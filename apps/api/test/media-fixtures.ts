// Photo fixtures that carry identifying metadata the way a phone writes it
// (EXIF Make/Model/Artist/serial number, GPS, XMP, comments, a second picture
// after the end of the image), built byte by byte because exiftool is not available.
// Used by the unit tests of processing/image-files.ts and by the media e2e tests.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';

export const WITNESS = {
  make: 'Apple',
  model: 'iPhone 15 Pro',
  artist: 'Priya Kumar (owner)',
  serial: 'SN-F2LXK3ABCD',
  lat: 11.0168,
  lng: 76.9558,
  dateTimeOriginal: '2026:10:10 18:42:07',
};

type Entry = { tag: number; type: number; count: number; value: Buffer };

/** Little-endian TIFF with IFD0 (+ Exif and GPS sub-IFDs), the payload of a JPEG APP1 "Exif" block. */
export function identifyingTiff(orientation = 6): Buffer {
  const ascii = (s: string) => Buffer.from(`${s}\0`, 'latin1');
  const short = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const long = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const rationals = (values: number[]) =>
    Buffer.concat(values.map((v) => Buffer.concat([long(Math.round(v * 10000)), long(10000)])));
  const dms = (deg: number) => {
    const d = Math.floor(deg);
    const m = Math.floor((deg - d) * 60);
    const s = ((deg - d) * 60 - m) * 60;
    return [d, m, s];
  };

  // Layout: header(8) | IFD0 | Exif IFD | GPS IFD | data area. Offsets are filled in two passes.
  const ifd0: Entry[] = [
    { tag: 0x010f, type: 2, count: 0, value: ascii(WITNESS.make) },
    { tag: 0x0110, type: 2, count: 0, value: ascii(WITNESS.model) },
    { tag: 0x0112, type: 3, count: 1, value: short(orientation) },
    { tag: 0x013b, type: 2, count: 0, value: ascii(WITNESS.artist) },
    { tag: 0x8769, type: 4, count: 1, value: long(0) }, // Exif IFD pointer, patched below
    { tag: 0x8825, type: 4, count: 1, value: long(0) }, // GPS IFD pointer, patched below
  ];
  const exif: Entry[] = [
    { tag: 0x9003, type: 2, count: 0, value: ascii(WITNESS.dateTimeOriginal) },
    { tag: 0xa431, type: 2, count: 0, value: ascii(WITNESS.serial) }, // BodySerialNumber
  ];
  const gps: Entry[] = [
    { tag: 0x0001, type: 2, count: 2, value: ascii('N') },
    { tag: 0x0002, type: 5, count: 3, value: rationals(dms(WITNESS.lat)) },
    { tag: 0x0003, type: 2, count: 2, value: ascii('E') },
    { tag: 0x0004, type: 5, count: 3, value: rationals(dms(WITNESS.lng)) },
  ];
  for (const e of [...ifd0, ...exif, ...gps]) if (e.type === 2) e.count = e.value.length;

  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0.length);
  const gpsAt = exifAt + ifdSize(exif.length);
  let dataAt = gpsAt + ifdSize(gps.length);
  ifd0[4].value = long(exifAt);
  ifd0[5].value = long(gpsAt);

  const data: Buffer[] = [];
  const writeIfd = (entries: Entry[]) => {
    const out = Buffer.alloc(ifdSize(entries.length));
    out.writeUInt16LE(entries.length, 0);
    entries.forEach((e, i) => {
      const p = 2 + i * 12;
      out.writeUInt16LE(e.tag, p);
      out.writeUInt16LE(e.type, p + 2);
      out.writeUInt32LE(e.count, p + 4);
      if (e.value.length <= 4) e.value.copy(out, p + 8);
      else {
        out.writeUInt32LE(dataAt, p + 8);
        data.push(e.value);
        dataAt += e.value.length;
      }
    });
    return out;
  };
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  return Buffer.concat([header, writeIfd(ifd0), writeIfd(exif), writeIfd(gps), ...data]);
}

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

const XMP = Buffer.from(
  'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ' +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="${WITNESS.artist}"/></rdf:RDF></x:xmpmeta>`,
  'latin1',
);

/** Runs FFmpeg to make a small picture in `format`; returns its bytes. */
export function ffmpegPicture(format: 'jpg' | 'png' | 'webp', size = '64x48'): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-pic-'));
  try {
    const file = path.join(dir, `p.${format}`);
    execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}`, '-frames:v', '1', file]);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A JPEG the way a phone writes one: JFIF, then EXIF (orientation 6 = "rotate 90° CW"
 * to display), XMP with the owner's name, a comment, an MPF-like APP2, and a second
 * JPEG with its own EXIF glued after the end-of-image marker.
 */
export function identifyingJpeg(): Buffer {
  const plain = ffmpegPicture('jpg');
  // FFmpeg writes SOI + APP0 (JFIF) first; insert our blocks right after APP0.
  const app0End = 4 + plain.readUInt16BE(4);
  const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), identifyingTiff()]));
  const trailer = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), identifyingTiff(1)])),
    Buffer.from([0xff, 0xd9]),
  ]);
  return Buffer.concat([
    plain.subarray(0, app0End),
    exif,
    segment(0xe1, XMP),
    segment(0xe2, Buffer.from(`MPF\0${WITNESS.serial}`, 'latin1')),
    segment(0xfe, Buffer.from(`Taken by ${WITNESS.artist}`, 'latin1')),
    plain.subarray(app0End),
    trailer,
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG with eXIf (GPS, make, model, orientation 6), an XMP iTXt chunk and a tEXt Author chunk. */
export function identifyingPng(): Buffer {
  const plain = ffmpegPicture('png');
  const ihdrEnd = 8 + 12 + plain.readUInt32BE(8);
  return Buffer.concat([
    plain.subarray(0, ihdrEnd),
    pngChunk('eXIf', identifyingTiff()),
    pngChunk('tEXt', Buffer.from(`Author\0${WITNESS.artist}`, 'latin1')),
    pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), XMP.subarray(29)])),
    plain.subarray(ihdrEnd),
  ]);
}

/** A PNG header that declares width × height pixels (the image data is irrelevant to the size check). */
export function pngDeclaring(width: number, height: number): Buffer {
  const plain = ffmpegPicture('png', '16x16');
  const out = Buffer.from(plain);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)) >>> 0, 29); // IHDR CRC
  return out;
}

/** An extended-format WebP (VP8X) with EXIF and XMP chunks. */
export function identifyingWebp(): Buffer {
  const plain = ffmpegPicture('webp');
  const first = plain.toString('latin1', 12, 16);
  const chunks: Buffer[] = [];
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
  };
  let image = plain.subarray(12);
  let width = 64;
  let height = 48;
  if (first === 'VP8X') {
    width = 1 + plain.readUIntLE(24, 3);
    height = 1 + plain.readUIntLE(27, 3);
    image = plain.subarray(12 + 8 + 10);
  }
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04; // EXIF + XMP
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  chunks.push(chunk('VP8X', vp8x), image, chunk('EXIF', identifyingTiff()), chunk('XMP ', XMP.subarray(29)));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/** Every identifying string the fixtures contain, to search the delivered bytes for. */
export const IDENTIFYING_STRINGS = [WITNESS.make, WITNESS.model, WITNESS.artist, WITNESS.serial, 'Priya'];
