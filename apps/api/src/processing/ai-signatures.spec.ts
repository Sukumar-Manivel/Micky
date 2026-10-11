import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHeadAndTail, scanAiSignatures } from './ai-signatures.js';

const bytes = (...parts: (string | Buffer)[]) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)));
const noise = (n = 4096) => randomBytes(n);

// A PNG text chunk as AUTOMATIC1111 / Forge write it ("parameters" keyword).
const a1111 =
  'tEXtparameters\0a burning warehouse at night, news photo, 35mm\nNegative prompt: cartoon\n' +
  'Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234, Size: 1024x768, Model: sdxl';

// XMP as Google, OpenAI, Adobe and Meta write it (IPTC digital source type).
const xmp = (type: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description Iptc4xmpExt:DigitalSourceType=` +
  `"http://cv.iptc.org/newscodes/digitalsourcetype/${type}"/></x:xmpmeta>`;

describe('scanAiSignatures', () => {
  it.each([
    ['IPTC "trainedAlgorithmicMedia" (Google, OpenAI, Meta, Adobe…)', xmp('trainedAlgorithmicMedia'), 'trained algorithmic media'],
    ['Midjourney in EXIF/XMP', 'Software\0Midjourney v7', 'Midjourney'],
    ['AUTOMATIC1111 generation parameters', a1111, 'Stable Diffusion'],
    ['ComfyUI workflow', 'tEXtprompt\0{"3": {"class_type": "KSampler", "inputs": {}}}', 'ComfyUI'],
    ['DALL·E (UTF-8 middle dot)', 'Software\0DALLÂ·E 3', 'DALL·E'],
    ['ChatGPT C2PA claim generator', 'claim_generator\0ChatGPT', 'DALL·E'],
    ['Adobe Firefly', 'CreatorTool>Adobe Firefly Image 3<', 'Adobe Firefly'],
    ['Google "Made with Google AI" credit', 'Credit\0Made with Google AI', 'Google AI'],
    ['Flux by Black Forest Labs', 'Software\0Black Forest Labs FLUX.1', 'Flux'],
  ])('finds %s', (_name, label, tool) => {
    const found = scanAiSignatures([bytes(noise(), label, noise())]);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].tool).toContain(tool);
    expect(found[0].kind).toBe('generated');
    expect(found[0].evidence.length).toBeGreaterThan(3);
  });

  it('reports a real photo edited with generative AI as "edited", not "generated"', () => {
    const found = scanAiSignatures([bytes(noise(), xmp('compositeWithTrainedAlgorithmicMedia'), noise())]);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('edited');
  });

  it('is case-insensitive and also reads extra metadata strings (EXIF Software, ffprobe tags, C2PA)', () => {
    expect(scanAiSignatures([noise()], ['MIDJOURNEY'])[0].tool).toBe('Midjourney');
    expect(scanAiSignatures([noise()], [null, undefined, 'Apple iPhone 15'])).toEqual([]);
  });

  it('stays silent on ordinary camera metadata and on random data', () => {
    const camera = bytes(
      'Exif\0\0MM\0*', noise(512), 'Apple\0iPhone 15 Pro\0Software\0' + '17.6.1\0',
      'com.apple.quicktime.make\0Apple', 'encoder\0Lavf61.7.100', 'Samsung SM-S921B', 'Google Pixel 9 Pro', 'Snapchat',
    );
    expect(scanAiSignatures([camera])).toEqual([]);
    // 32 MB of random bytes: no pattern is short enough to appear by chance.
    expect(scanAiSignatures([randomBytes(16 * 1024 * 1024), randomBytes(16 * 1024 * 1024)])).toEqual([]);
  });
});

describe('readHeadAndTail', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-sig-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a small file whole, and only both ends of a big one', async () => {
    const small = path.join(dir, 'small.bin');
    writeFileSync(small, bytes('head', 'tail'));
    expect((await readHeadAndTail(small, 16)).map(String)).toEqual(['headtail']);

    const big = path.join(dir, 'big.bin');
    writeFileSync(big, bytes('HEAD', Buffer.alloc(100), 'midjourney-in-the-middle', Buffer.alloc(100), 'TAIL'));
    const parts = await readHeadAndTail(big, 8);
    expect(parts.map((p) => p.toString('latin1'))).toEqual(['HEAD\0\0\0\0', '\0\0\0\0TAIL']);
  });

  it('finds a label in a real MP4 written by ffmpeg (metadata at the end of the file)', async () => {
    const mp4 = path.join(dir, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'comment=Made with Google AI', mp4,
    ]);
    const found = scanAiSignatures(await readHeadAndTail(mp4, 64 * 1024));
    expect(found.map((s) => s.tool)).toEqual(['Google AI (Gemini / Imagen)']);
  });
});
