// Thin wrappers around the ffmpeg and ffprobe command-line tools.
//
// Security note: commands are started with spawn() and an argument array, never
// through a shell, so a file name or title can never be interpreted as a shell
// command. Every input file path is created by us (temp dirs), not by users.
import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const WATERMARK_TEXT = 'MICKY PREVIEW';

/**
 * Decompression-bomb guard. A tiny PNG can declare 16000 × 16000 pixels; decoding it
 * would allocate about 1 GB. FFmpeg's `max_pixels` decoder option refuses any frame
 * larger than this before allocating it. Passed before every `-i` that reads an
 * uploaded original (see `untrustedInput`).
 */
export const MAX_DECODE_PIXELS = 50_000_000;

/** Timeouts per kind of command, so one hostile file cannot hold the worker for long. */
export const TIMEOUT = {
  probe: 30_000,
  frame: 60_000,
  render: 5 * 60_000,
  copy: 5 * 60_000,
} as const;

/** Input options for a file a user uploaded: the pixel limit, then the file. */
export function untrustedInput(file: string): string[] {
  return ['-max_pixels', String(MAX_DECODE_PIXELS), '-i', file];
}

/** Error from an external tool, with the end of its stderr (the useful part). */
export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
    this.name = 'ToolError';
  }
}

/** Runs a command and resolves with its stdout. Rejects on a non-zero exit or timeout. */
export function run(cmd: string, args: string[], timeoutMs: number = TIMEOUT.render): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000); // keep only the tail
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ToolError(cmd, err.message)); // e.g. ENOENT: tool not installed
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(Buffer.concat(stdout).toString('utf8'));
      const reason = signal ? `killed by ${signal} (timeout ${timeoutMs} ms?)` : `exit code ${code}`;
      const lastLine = stderr.trim().split('\n').slice(-3).join(' | ');
      reject(new ToolError(cmd, `${reason}${lastLine ? `: ${lastLine}` : ''}`));
    });
  });
}

/** ffmpeg with quiet logging, overwriting outputs, no stdin. */
function ffmpeg(args: string[], timeoutMs?: number) {
  return run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], timeoutMs);
}

// ---------- Probing ----------

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

export interface FfprobeOutput {
  format?: { format_name?: string; duration?: string; tags?: Record<string, string> };
  streams?: FfprobeStream[];
}

/** Runs ffprobe and returns its JSON description of the file (container + streams). */
export async function ffprobe(filePath: string): Promise<FfprobeOutput> {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-max_pixels', String(MAX_DECODE_PIXELS), '-print_format', 'json', '-show_format', '-show_streams', filePath],
    TIMEOUT.probe,
  );
  return JSON.parse(out) as FfprobeOutput;
}

/**
 * Rotation (degrees) that FFmpeg applies when it decodes the first frame.
 * For JPEGs this comes from the EXIF orientation flag. FFmpeg (6.1+) rotates
 * such images upright by itself ("autorotate"), so callers only need the angle
 * to know the upright width and height, never to rotate again.
 */
export async function firstFrameRotation(filePath: string): Promise<number> {
  const out = await run(
    'ffprobe',
    [
      '-v', 'error', '-max_pixels', String(MAX_DECODE_PIXELS),
      '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', '-print_format', 'json', filePath,
    ],
    TIMEOUT.probe,
  );
  const parsed = JSON.parse(out) as { frames?: { side_data_list?: { rotation?: number }[] }[] };
  const rotation = parsed.frames?.[0]?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  return rotation ?? 0;
}

// ---------- Watermark ----------

let fontPromise: Promise<string | null> | undefined;

/**
 * Finds a bold sans-serif font file with fontconfig (`fc-match`). Returns null
 * if fontconfig is missing; drawtext then falls back to FFmpeg's default font.
 */
function findFont(): Promise<string | null> {
  fontPromise ??= run('fc-match', ['-f', '%{file}', 'DejaVu Sans:bold'], 10_000)
    .then((file) => file.trim() || null)
    .catch(() => null);
  return fontPromise;
}

/** Escapes a value for use inside an FFmpeg filter option (quoted with '...'). */
function filterValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;
}

export interface WatermarkStyle {
  /** The text to tile. Default "MICKY PREVIEW". */
  text?: string;
  /** 0..1. Default 0.32. */
  opacity?: number;
  /** Font size as a fraction of the frame's short side. Default 1/16. */
  fontScale?: number;
  /** Rotation of the text lines in degrees (counter-clockwise). Default 30. */
  angleDeg?: number;
  /** Output file name inside `dir` (several marks can live in one work dir). */
  name?: string;
}

/**
 * Draws a transparent PNG of exactly width × height pixels with a text tiled
 * diagonally over all of it.
 *
 * How: write many lines of the text on a transparent square big enough to
 * cover the frame's diagonal, rotate the square, then crop the centre.
 * The PNG is then laid over every frame with FFmpeg's overlay filter.
 */
export async function makeWatermark(dir: string, width: number, height: number, style: WatermarkStyle = {}): Promise<string> {
  const text = (style.text ?? WATERMARK_TEXT).replace(/[\r\n]+/g, ' ');
  const opacity = (style.opacity ?? 0.32).toFixed(2);
  const angle = style.angleDeg ?? 30;
  const side = Math.ceil(Math.hypot(width, height)) + 2;
  const fontSize = Math.max(12, Math.round(Math.min(width, height) * (style.fontScale ?? 1 / 16)));
  const lineSpacing = Math.round(fontSize * 2.2);
  const lineCount = Math.ceil(side / (fontSize + lineSpacing)) + 1;
  // A bold glyph is roughly 0.65 × the font size wide.
  const unit = `${text}      `;
  const repeats = Math.ceil(side / (unit.length * fontSize * 0.65)) + 1;
  const lines = Array.from({ length: lineCount }, (_, i) =>
    // Shift every other line by half a unit so the pattern looks tiled, not striped.
    (i % 2 ? ' '.repeat(Math.floor(unit.length / 2)) : '') + unit.repeat(repeats),
  );
  const base = style.name ?? `watermark_${width}x${height}`;
  const textFile = path.join(dir, `${base}.txt`);
  await writeFile(textFile, lines.join('\n'));

  const font = await findFont();
  const drawtext = [
    `textfile=${filterValue(textFile)}`,
    ...(font ? [`fontfile=${filterValue(font)}`] : []),
    `fontsize=${fontSize}`,
    `fontcolor=white@${opacity}`,
    'borderw=1',
    `bordercolor=black@${(Number(opacity) * 0.6).toFixed(2)}`,
    `line_spacing=${lineSpacing}`,
    'x=0',
    'y=0',
  ].join(':');

  const output = path.join(dir, `${base}.png`);
  await ffmpeg(
    [
      '-f', 'lavfi',
      '-i', `color=c=black@0.0:s=${side}x${side},format=rgba`,
      '-vf', `drawtext=${drawtext},rotate=-${(angle * Math.PI) / 180}:c=none,crop=${width}:${height}`,
      '-frames:v', '1',
      '-update', '1',
      output,
    ],
    TIMEOUT.frame,
  );
  return output;
}

// ---------- Outputs ----------

/** Scale (and orient) a stream, then lay the watermark over it. */
function watermarkGraph(prefilters: string[], width: number, height: number, extra: string[] = []) {
  const base = [...prefilters, `scale=${width}:${height}`, 'setsar=1'].join(',');
  return `[0:v]${base}[base];[base][1:v]overlay=0:0,${['format=yuv420p', ...extra].join(',')}[out]`;
}

/** HLS muxer options shared by every preview rendition: 4 s AES-128 segments, VOD playlist. */
async function hlsOutput(opts: { keyFile: string; workDir: string; outDir: string }): Promise<string[]> {
  // The key info file has 2 lines: the key URI written into the playlist, then the local key path.
  // The URI is a placeholder: StreamService rewrites it to a short-lived, per-viewer key URL.
  const keyInfo = path.join(opts.workDir, `hls-${path.basename(opts.outDir)}.keyinfo`);
  await writeFile(keyInfo, `key.bin\n${opts.keyFile}\n`);
  return [
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_playlist_type', 'vod',
    '-hls_key_info_file', keyInfo,
    '-hls_segment_filename', path.join(opts.outDir, 'seg_%03d.ts'),
    path.join(opts.outDir, 'index.m3u8'),
  ];
}

/**
 * Step 1 of a video preview: the "mezzanine", a private MP4 that is already cut to
 * the preview length, scaled down and carries the generic tiled mark. It is never
 * served. Every rendition (the generic one for the owner and admins, and one per
 * newsroom with its name burned in) is made from it, so the expensive decode of a
 * large original happens once.
 */
export async function encodeMezzanine(opts: {
  input: string;
  watermark: string;
  width: number;
  height: number;
  maxSeconds: number;
  output: string;
}): Promise<void> {
  await ffmpeg([
    // -t before -i: stop *reading* the original after maxSeconds.
    '-t', opts.maxSeconds.toFixed(2),
    ...untrustedInput(opts.input),
    '-i', opts.watermark,
    '-filter_complex', watermarkGraph([], opts.width, opts.height),
    '-map', '[out]',
    '-map', '0:a:0?', // first audio track, if there is one
    '-map_metadata', '-1', // drop the original's tags (GPS, device)
    '-map_chapters', '-1',
    '-sn', '-dn',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    // A keyframe every 4 s, so the HLS muxer can cut 4 s segments without re-encoding.
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-movflags', '+faststart',
    opts.output,
  ], TIMEOUT.render);
}

/**
 * The generic encrypted HLS preview (owner and admin view): the mezzanine cut into
 * segments without re-encoding (`-c copy`), so it costs almost nothing.
 */
export async function segmentHls(opts: { input: string; keyFile: string; workDir: string; outDir: string }) {
  await ffmpeg(['-i', opts.input, '-map', '0', '-c', 'copy', '-map_metadata', '-1', ...(await hlsOutput(opts))], TIMEOUT.render);
}

/**
 * A per-newsroom rendition: the mezzanine with a second, viewer-specific mark
 * (organisation name + short viewer id) burned into the pixels, as encrypted HLS.
 * `superfast` + a bitrate cap keeps the CPU cost and the cache size small
 * (measured in docs/learning/media-and-processing.md).
 */
export async function renderViewerHls(opts: {
  input: string;
  overlay: string;
  maxrateKbps: number;
  keyFile: string;
  workDir: string;
  outDir: string;
}) {
  await ffmpeg([
    '-i', opts.input,
    '-i', opts.overlay,
    '-filter_complex', '[0:v][1:v]overlay=0:0,format=yuv420p[out]',
    '-map', '[out]',
    '-map', '0:a:0?',
    '-map_metadata', '-1',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '30',
    '-maxrate', `${opts.maxrateKbps}k`, '-bufsize', `${opts.maxrateKbps * 2}k`,
    '-threads', '2',
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-c:a', 'copy',
    ...(await hlsOutput(opts)),
  ], TIMEOUT.render);
}

/**
 * Writes one watermarked JPEG of `width` × `height` from an image or from a
 * video frame at `atSecond`. `orient` is a list of filters that rotate the
 * source upright (needed for photos with an EXIF orientation flag).
 */
export async function renderWatermarkedJpeg(opts: {
  input: string;
  watermark: string;
  output: string;
  width: number;
  height: number;
  atSecond?: number;
  orient?: string[];
}): Promise<void> {
  await ffmpeg([
    ...(opts.atSecond !== undefined ? ['-ss', opts.atSecond.toFixed(2)] : []),
    ...untrustedInput(opts.input),
    '-i', opts.watermark,
    '-filter_complex', watermarkGraph(opts.orient ?? [], opts.width, opts.height),
    '-map', '[out]',
    '-map_metadata', '-1',
    '-frames:v', '1',
    '-q:v', '4', // JPEG quality: 2 = best, 31 = worst
    '-update', '1',
    opts.output,
  ], TIMEOUT.frame);
}

/**
 * Samples up to `maxFrames` frames, `everySeconds` apart, as 512 px wide JPEGs
 * for the verifier. Returns the frame paths in time order.
 */
export async function sampleVideoFrames(opts: {
  input: string;
  outDir: string;
  everySeconds: number;
  maxFrames: number;
}): Promise<string[]> {
  await ffmpeg([
    ...untrustedInput(opts.input),
    '-vf', `fps=1/${opts.everySeconds.toFixed(3)},scale=512:-2`,
    '-frames:v', String(opts.maxFrames),
    '-q:v', '3',
    path.join(opts.outDir, 'frame_%02d.jpg'),
  ], TIMEOUT.render);
  let frames = await listFrames(opts.outDir);
  if (frames.length === 0) {
    // Very short clips can produce no frame with the fps filter: take the first one.
    await ffmpeg(
      [...untrustedInput(opts.input), '-vf', 'scale=512:-2', '-frames:v', '1', path.join(opts.outDir, 'frame_01.jpg')],
      TIMEOUT.frame,
    );
    frames = await listFrames(opts.outDir);
  }
  return frames;
}

/** Converts a photo to an upright JPEG (long side ≤ `maxSide`) for the verifier. */
export async function photoFrame(opts: { input: string; output: string; orient: string[]; maxSide: number }) {
  const scale = `scale='if(gte(iw,ih),min(${opts.maxSide},iw),-2)':'if(gte(iw,ih),-2,min(${opts.maxSide},ih))'`;
  await ffmpeg([
    ...untrustedInput(opts.input),
    '-vf', [...opts.orient, scale, 'format=yuvj420p'].join(','),
    '-frames:v', '1',
    '-q:v', '3',
    '-update', '1',
    opts.output,
  ], TIMEOUT.frame);
}

// ---------- Delivery copies (what a buyer downloads) ----------

/**
 * A copy of a video without identifying metadata, bit-for-bit the same audio and
 * video (`-c copy`, no quality loss):
 * - `-map 0:V -map 0:a?`: video (not cover art) and audio only. Data tracks are
 *   dropped: GoPro/DJI telemetry and Apple "mebx" tracks can carry GPS per frame.
 * - `-map_metadata -1 -map_chapters -1`: no container/stream tags (location, make,
 *   model, artist, software, comments) and no chapters.
 * - `-fflags +bitexact`: FFmpeg does not add its own version tag.
 * - The capture time is written back on purpose (`creationTime`): it is already
 *   public in the marketplace, and newsrooms need it.
 * The display matrix (rotation) is stream side data, not a tag, so portrait clips
 * stay portrait.
 */
export async function stripVideoMetadata(opts: {
  input: string;
  output: string;
  creationTime: string | null;
  mp4Family: boolean;
}): Promise<void> {
  await ffmpeg([
    ...untrustedInput(opts.input),
    '-map', '0:V',
    '-map', '0:a?',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-sn', '-dn',
    '-c', 'copy',
    '-fflags', '+bitexact',
    ...(opts.creationTime ? ['-metadata', `creation_time=${opts.creationTime}`] : []),
    ...(opts.mp4Family ? ['-movflags', '+faststart'] : []),
    opts.output,
  ], TIMEOUT.copy);
}

/** Last resort for photo formats we cannot clean losslessly: an upright, high-quality JPEG with no metadata. */
export async function reencodePhotoAsJpeg(input: string, output: string): Promise<void> {
  await ffmpeg(
    [...untrustedInput(input), '-map_metadata', '-1', '-frames:v', '1', '-q:v', '2', '-update', '1', output],
    TIMEOUT.frame,
  );
}

async function listFrames(dir: string): Promise<string[]> {
  return (await readdir(dir))
    .filter((name) => /^frame_\d+\.jpg$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}
