// Thin wrappers around the ffmpeg and ffprobe command-line tools.
//
// Security note: commands are started with spawn() and an argument array, never
// through a shell, so a file name or title can never be interpreted as a shell
// command. Every input file path is created by us (temp dirs), not by users.
import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const WATERMARK_TEXT = 'FIRSTFRAME PREVIEW';

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
export function run(cmd: string, args: string[], timeoutMs = 10 * 60_000): Promise<string> {
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
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    60_000,
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
    ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', '-print_format', 'json', filePath],
    60_000,
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

/**
 * Draws a transparent PNG of exactly width × height pixels with
 * "FIRSTFRAME PREVIEW" tiled diagonally at 30% opacity.
 *
 * How: write many lines of the text on a transparent square big enough to
 * cover the frame's diagonal, rotate the square by 30°, then crop the centre.
 * The PNG is then laid over every frame with FFmpeg's overlay filter.
 */
export async function makeWatermark(dir: string, width: number, height: number): Promise<string> {
  const side = Math.ceil(Math.hypot(width, height)) + 2;
  const fontSize = Math.max(12, Math.round(Math.min(width, height) / 16));
  const lineSpacing = Math.round(fontSize * 2.2);
  const lineCount = Math.ceil(side / (fontSize + lineSpacing)) + 1;
  // A bold glyph is roughly 0.65 × the font size wide.
  const unit = `${WATERMARK_TEXT}      `;
  const repeats = Math.ceil(side / (unit.length * fontSize * 0.65)) + 1;
  const lines = Array.from({ length: lineCount }, (_, i) =>
    // Shift every other line by half a unit so the pattern looks tiled, not striped.
    (i % 2 ? ' '.repeat(unit.length / 2) : '') + unit.repeat(repeats),
  );
  const textFile = path.join(dir, 'watermark.txt');
  await writeFile(textFile, lines.join('\n'));

  const font = await findFont();
  const drawtext = [
    `textfile=${filterValue(textFile)}`,
    ...(font ? [`fontfile=${filterValue(font)}`] : []),
    `fontsize=${fontSize}`,
    'fontcolor=white@0.32',
    'borderw=1',
    'bordercolor=black@0.18',
    `line_spacing=${lineSpacing}`,
    'x=0',
    'y=0',
  ].join(':');

  const output = path.join(dir, `watermark_${width}x${height}.png`);
  await ffmpeg([
    '-f', 'lavfi',
    '-i', `color=c=black@0.0:s=${side}x${side},format=rgba`,
    '-vf', `drawtext=${drawtext},rotate=-PI/6:c=none,crop=${width}:${height}`,
    '-frames:v', '1',
    '-update', '1',
    output,
  ]);
  return output;
}

// ---------- Outputs ----------

/** Scale (and orient) a stream, then lay the watermark over it. */
function watermarkGraph(prefilters: string[], width: number, height: number, extra: string[] = []) {
  const base = [...prefilters, `scale=${width}:${height}`, 'setsar=1'].join(',');
  return `[0:v]${base}[base];[base][1:v]overlay=0:0,${['format=yuv420p', ...extra].join(',')}[out]`;
}

/**
 * Creates the encrypted HLS preview of a video in `outDir`:
 * index.m3u8 + seg_000.ts, seg_001.ts, ... (AES-128 encrypted with the key in `keyFile`).
 *
 * The playlist's key line is `#EXT-X-KEY:METHOD=AES-128,URI="key.bin"`; the
 * relative URI makes the player fetch the key from the same signed stream URL.
 */
export async function encodeHlsPreview(opts: {
  input: string;
  watermark: string;
  width: number;
  height: number;
  maxSeconds: number;
  keyFile: string;
  workDir: string;
  outDir: string;
}): Promise<void> {
  // The key info file has 2 lines: the key URI written into the playlist, then the local key path.
  const keyInfo = path.join(opts.workDir, 'hls.keyinfo');
  await writeFile(keyInfo, `key.bin\n${opts.keyFile}\n`);

  await ffmpeg([
    '-i', opts.input,
    '-i', opts.watermark,
    '-t', String(opts.maxSeconds),
    '-filter_complex', watermarkGraph([], opts.width, opts.height),
    '-map', '[out]',
    '-map', '0:a:0?', // first audio track, if there is one
    '-map_metadata', '-1', // drop the original's tags (GPS, device) from the preview
    '-sn', '-dn',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    // A keyframe every 4 s, so every 4 s segment can start playing on its own.
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_playlist_type', 'vod',
    '-hls_key_info_file', keyInfo,
    '-hls_segment_filename', path.join(opts.outDir, 'seg_%03d.ts'),
    path.join(opts.outDir, 'index.m3u8'),
  ]);
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
    '-i', opts.input,
    '-i', opts.watermark,
    '-filter_complex', watermarkGraph(opts.orient ?? [], opts.width, opts.height),
    '-map', '[out]',
    '-map_metadata', '-1',
    '-frames:v', '1',
    '-q:v', '4', // JPEG quality: 2 = best, 31 = worst
    '-update', '1',
    opts.output,
  ]);
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
    '-i', opts.input,
    '-vf', `fps=1/${opts.everySeconds.toFixed(3)},scale=512:-2`,
    '-frames:v', String(opts.maxFrames),
    '-q:v', '3',
    path.join(opts.outDir, 'frame_%02d.jpg'),
  ]);
  let frames = await listFrames(opts.outDir);
  if (frames.length === 0) {
    // Very short clips can produce no frame with the fps filter: take the first one.
    await ffmpeg(['-i', opts.input, '-vf', 'scale=512:-2', '-frames:v', '1', path.join(opts.outDir, 'frame_01.jpg')]);
    frames = await listFrames(opts.outDir);
  }
  return frames;
}

/** Converts a photo to an upright JPEG (long side ≤ `maxSide`) for the verifier. */
export async function photoFrame(opts: { input: string; output: string; orient: string[]; maxSide: number }) {
  const scale = `scale='if(gte(iw,ih),min(${opts.maxSide},iw),-2)':'if(gte(iw,ih),-2,min(${opts.maxSide},ih))'`;
  await ffmpeg([
    '-i', opts.input,
    '-vf', [...opts.orient, scale, 'format=yuvj420p'].join(','),
    '-frames:v', '1',
    '-q:v', '3',
    '-update', '1',
    opts.output,
  ]);
}

async function listFrames(dir: string): Promise<string[]> {
  return (await readdir(dir))
    .filter((name) => /^frame_\d+\.jpg$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}
