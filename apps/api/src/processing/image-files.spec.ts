import exifr from 'exifr';
import {
  ffmpegPicture,
  IDENTIFYING_STRINGS,
  identifyingJpeg,
  identifyingPng,
  identifyingWebp,
  pngDeclaring,
  WITNESS,
} from '../../test/media-fixtures.js';
import { buildMinimalExif, ImageFormatError, imageDimensions, stripImageMetadata } from './image-files.js';

/** exifr reports the PNG IHDR fields as tags; they are not metadata. */
const PNG_HEADER_FIELDS = ['ImageWidth', 'ImageHeight', 'BitDepth', 'ColorType', 'Compression', 'Filter', 'Interlace'];
const KEEP = { orientation: 6, dateTimeOriginal: WITNESS.dateTimeOriginal };

function expectNoIdentifyingBytes(buf: Buffer) {
  const text = buf.toString('latin1');
  for (const s of IDENTIFYING_STRINGS) expect(text, `still contains "${s}"`).not.toContain(s);
}

async function tagsOf(buf: Buffer) {
  return (await exifr.parse(buf, {
    tiff: true, exif: true, gps: true, ifd1: true, xmp: true, iptc: true, makerNote: true, userComment: true,
  })) as Record<string, unknown> | undefined;
}

describe('imageDimensions (decompression-bomb check without decoding)', () => {
  it('reads JPEG, PNG and WebP headers', () => {
    expect(imageDimensions(ffmpegPicture('jpg', '320x240'))).toEqual({ width: 320, height: 240 });
    expect(imageDimensions(ffmpegPicture('png', '300x200'))).toEqual({ width: 300, height: 200 });
    expect(imageDimensions(ffmpegPicture('webp', '128x96'))).toEqual({ width: 128, height: 96 });
    // EXIF blocks in front of the frame header are skipped.
    expect(imageDimensions(identifyingJpeg())).toEqual({ width: 64, height: 48 });
  });

  it('reports what a hostile header declares', () => {
    expect(imageDimensions(pngDeclaring(16000, 16000))).toEqual({ width: 16000, height: 16000 });
  });

  it('returns null for anything else', () => {
    expect(imageDimensions(Buffer.from('not an image at all'))).toBeNull();
  });
});

describe('stripImageMetadata', () => {
  it('JPEG: keeps the image data, orientation and capture time; drops GPS, device, owner, XMP, comments, trailers', async () => {
    const input = identifyingJpeg();
    const before = await tagsOf(input);
    expect(before).toMatchObject({ Make: WITNESS.make, Model: WITNESS.model, Artist: WITNESS.artist });
    expect(before?.latitude).toBeCloseTo(WITNESS.lat, 3);

    const out = stripImageMetadata('jpeg', input, KEEP);
    expectNoIdentifyingBytes(out);
    const after = await tagsOf(out);
    expect(Object.keys(after ?? {}).sort()).toEqual(['DateTimeOriginal', 'Orientation']);
    expect(await exifr.orientation(out)).toBe(6);
    // Same compressed picture: the bytes from the first DQT to EOI are unchanged.
    const plain = ffmpegPicture('jpg');
    const dqt = (b: Buffer) => b.subarray(b.indexOf(Buffer.from([0xff, 0xdb])));
    expect(dqt(out).equals(dqt(input).subarray(0, dqt(out).length))).toBe(true);
    expect(out.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(dqt(out).length).toBe(dqt(plain).length);
  });

  it('JPEG: writes no EXIF at all when there is nothing worth keeping', async () => {
    const out = stripImageMetadata('jpeg', identifyingJpeg(), {});
    expect(out.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect(await tagsOf(out)).toBeUndefined();
  });

  it('PNG: drops eXIf/tEXt/iTXt and writes back only the orientation', async () => {
    const out = stripImageMetadata('png', identifyingPng(), { orientation: 6 });
    expectNoIdentifyingBytes(out);
    const tags = Object.keys((await tagsOf(out)) ?? {}).filter((k) => !PNG_HEADER_FIELDS.includes(k));
    expect(tags).toEqual(['Orientation']);
    expect(imageDimensions(out)).toEqual({ width: 64, height: 48 });
  });

  it('WebP: drops EXIF and XMP chunks and clears their flags', () => {
    const out = stripImageMetadata('webp', identifyingWebp(), {});
    expectNoIdentifyingBytes(out);
    expect(out.includes(Buffer.from('EXIF', 'latin1'))).toBe(false);
    expect(out[20] & 0x0c).toBe(0); // VP8X flags
    expect(out.readUInt32LE(4)).toBe(out.length - 8); // RIFF size fixed up
  });

  it('refuses malformed files instead of passing them through', () => {
    expect(() => stripImageMetadata('jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]), {})).toThrow(ImageFormatError);
    const truncated = ffmpegPicture('jpg').subarray(0, 300);
    expect(() => stripImageMetadata('jpeg', truncated, {})).toThrow(ImageFormatError);
    expect(() => stripImageMetadata('png', Buffer.from('nope'), {})).toThrow(ImageFormatError);
  });
});

describe('buildMinimalExif', () => {
  it('returns null when orientation is normal and there is no date', () => {
    expect(buildMinimalExif({ orientation: 1 })).toBeNull();
    expect(buildMinimalExif({ dateTimeOriginal: 'yesterday' })).toBeNull();
  });
});
