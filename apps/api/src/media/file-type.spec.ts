import { detectFileType } from './file-type.js';

/** Builds a fake file header: an optional 4-byte prefix, then the given ASCII/bytes. */
function bytes(...parts: (string | number[])[]): Uint8Array {
  return Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
}

describe('detectFileType', () => {
  it.each([
    ['mp4 (isom)', bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0]), 'video/mp4', '.mp4'],
    ['mp4 (mp42)', bytes([0, 0, 0, 0x18], 'ftypmp42'), 'video/mp4', '.mp4'],
    ['mov', bytes([0, 0, 0, 0x14], 'ftypqt  '), 'video/quicktime', '.mov'],
    ['webm', bytes([0x1a, 0x45, 0xdf, 0xa3, 0x01]), 'video/webm', '.webm'],
    ['jpeg', bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], 'JFIF'), 'image/jpeg', '.jpg'],
    ['png', bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]), 'image/png', '.png'],
    ['webp', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '), 'image/webp', '.webp'],
    ['heic', bytes([0, 0, 0, 0x18], 'ftypheic'), 'image/heic', '.heic'],
    ['heic (mif1)', bytes([0, 0, 0, 0x18], 'ftypmif1'), 'image/heic', '.heic'],
  ])('recognises %s', (_name, head, mime, ext) => {
    expect(detectFileType(head)).toMatchObject({ mime, ext });
  });

  it('classifies videos and photos', () => {
    expect(detectFileType(bytes([0, 0, 0, 0x20], 'ftypisom'))?.kind).toBe('VIDEO');
    expect(detectFileType(bytes([0xff, 0xd8, 0xff, 0xdb]))?.kind).toBe('PHOTO');
  });

  it.each([
    ['plain text', bytes('hello world, this is not a video')],
    ['html', bytes('<!doctype html><html>')],
    ['pdf', bytes('%PDF-1.7')],
    ['a RIFF file that is not WebP (wav)', bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt ')],
    ['an unknown ftyp brand (avif)', bytes([0, 0, 0, 0x18], 'ftypavif')],
    ['an empty file', bytes()],
    ['a truncated header', bytes([0xff, 0xd8])],
  ])('rejects %s', (_name, head) => {
    expect(detectFileType(head)).toBeNull();
  });
});
