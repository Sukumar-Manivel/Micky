// Test footage, generated with ffmpeg in global setup (videos are never committed).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR } from './env.js';

export const CLIPS = {
  /** The clip that goes through the whole money path. */
  main: path.join(FIXTURES_DIR, 'witness-main.mp4'),
  /** A different clip, sold exclusively in the negative tests. */
  exclusive: path.join(FIXTURES_DIR, 'witness-exclusive.mp4'),
  /** Uploaded twice by the same witness in the negative tests. */
  duplicate: path.join(FIXTURES_DIR, 'witness-duplicate.mp4'),
  /** A text file with an .mp4 name: must be rejected by the magic-byte check. */
  fake: path.join(FIXTURES_DIR, 'not-a-video.mp4'),
} as const;

/** Where both clips claim to have been filmed (Chennai Central), also written into the file. */
export const CLIP_LOCATION = { lat: 13.0827, lng: 80.2707 };

function makeClip(file: string, source: string, seconds: number, salt: string) {
  // A small 640x360 H.264/AAC clip with GPS and capture-time metadata, like a phone writes.
  // `comment` makes each run's file unique, which keeps the SHA-256 duplicate check honest.
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `${source}=size=640x360:rate=25`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      '-metadata', `creation_time=${new Date().toISOString()}`,
      '-metadata', `location=+${CLIP_LOCATION.lat.toFixed(4)}+0${CLIP_LOCATION.lng.toFixed(4)}/`,
      '-metadata', `comment=micky-e2e-${salt}`,
      '-movflags', '+faststart',
      file,
    ],
    { stdio: 'pipe' },
  );
}

export function generateFixtures(): void {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const salt = `${Date.now()}-${process.pid}`;
  makeClip(CLIPS.main, 'testsrc', 6, `main-${salt}`);
  makeClip(CLIPS.exclusive, 'testsrc2', 5, `exclusive-${salt}`);
  makeClip(CLIPS.duplicate, 'smptebars', 3, `duplicate-${salt}`);
  writeFileSync(CLIPS.fake, 'This is plain text pretending to be a video.\n'.repeat(50));
}

export function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
