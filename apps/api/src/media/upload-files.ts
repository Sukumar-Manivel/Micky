// Small file helpers for the upload route.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import multer from 'multer';

/** Reads the first `bytes` bytes of a file (for magic-byte sniffing) without reading the rest. */
export async function readHead(filePath: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * SHA-256 of a file, streamed in chunks, so a 500 MB video never sits in memory.
 * Two byte-identical files always have the same checksum; changing one byte changes it completely.
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Multer disk storage: files go to UPLOAD_TMP_DIR under a random name.
 * The client's file name is never used as a path, so "../../etc/passwd" is harmless.
 */
export function tempDiskStorage(dir: string): multer.StorageEngine {
  return multer.diskStorage({
    destination: (_req: Request, _file, cb) => {
      mkdir(dir, { recursive: true }).then(
        () => cb(null, dir),
        (err: Error) => cb(err, dir),
      );
    },
    filename: (_req: Request, _file, cb) => cb(null, `${randomUUID()}.upload`),
  });
}

/** The client's file name, kept only as information: control characters removed, at most 200 characters. */
export function cleanOriginalName(name: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = path.basename(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'upload').slice(0, 200);
}
