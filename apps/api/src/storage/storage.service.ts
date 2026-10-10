import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Global, Injectable, Logger, Module, NotFoundException } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppConfig } from '../config/app-config.js';

/**
 * One storage API with two drivers:
 * - "local": files on the server's disk (free; good for originals on the VM's 200 GB disk)
 * - "s3": any S3-compatible service (Cloudflare R2, Backblaze B2, MinIO, AWS S3)
 *
 * Keys look like "originals/<mediaId>/source.mp4" or "previews/<mediaId>/hls/index.m3u8".
 * Nothing in storage is public: files reach browsers only through the API's
 * signed, short-lived URLs.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3?: S3Client;
  private readonly root: string;

  constructor(private readonly config: AppConfig) {
    this.root = path.resolve(config.storageLocalDir);
    if (config.storageDriver === 's3') {
      this.s3 = new S3Client({
        endpoint: config.s3Endpoint,
        region: config.s3Region,
        forcePathStyle: config.s3ForcePathStyle,
        credentials: {
          accessKeyId: config.s3AccessKeyId!,
          secretAccessKey: config.s3SecretAccessKey!,
        },
      });
    }
  }

  /** Uploads a local file to storage under `key`. */
  async putFile(key: string, filePath: string, contentType: string): Promise<void> {
    this.assertKey(key);
    if (this.s3) {
      const size = (await stat(filePath)).size;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.s3Bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: size,
          ContentType: contentType,
        }),
      );
      return;
    }
    const target = this.localPath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(createReadStream(filePath), createWriteStream(target));
  }

  /** Uploads every file in a local directory, keeping relative paths, under `prefix`. */
  async putDirectory(prefix: string, dirPath: string, contentTypeOf: (name: string) => string) {
    for (const name of await readdir(dirPath)) {
      await this.putFile(`${prefix}/${name}`, path.join(dirPath, name), contentTypeOf(name));
    }
  }

  /** Opens a stream for reading. Throws NotFoundException if the key does not exist. */
  async getStream(key: string): Promise<{ stream: Readable; size?: number }> {
    this.assertKey(key);
    if (this.s3) {
      try {
        const res = await this.s3.send(new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
        return { stream: res.Body as Readable, size: res.ContentLength };
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') throw new NotFoundException('File not found');
        throw err;
      }
    }
    const filePath = this.localPath(key);
    try {
      const { size } = await stat(filePath);
      return { stream: createReadStream(filePath), size };
    } catch {
      throw new NotFoundException('File not found');
    }
  }

  /** Downloads an object to a local file (used by the worker). */
  async downloadTo(key: string, filePath: string): Promise<void> {
    const { stream } = await this.getStream(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(stream, createWriteStream(filePath));
  }

  /** Deletes every object whose key starts with `prefix`. */
  async deletePrefix(prefix: string): Promise<void> {
    this.assertKey(prefix);
    if (this.s3) {
      let token: string | undefined;
      do {
        const page = await this.s3.send(
          new ListObjectsV2Command({ Bucket: this.config.s3Bucket, Prefix: prefix, ContinuationToken: token }),
        );
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length) {
          await this.s3.send(new DeleteObjectsCommand({ Bucket: this.config.s3Bucket, Delete: { Objects: keys } }));
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return;
    }
    await rm(this.localPath(prefix), { recursive: true, force: true });
    this.logger.debug(`Deleted ${prefix}`);
  }

  /** Rejects keys that could escape the storage root ("..", absolute paths, backslashes). */
  private assertKey(key: string) {
    if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) {
      throw new Error(`Invalid storage key: ${key}`);
    }
  }

  private localPath(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }
}

/** Storage key helpers, so every module builds keys the same way. */
export const storageKeys = {
  original: (mediaId: string, ext: string) => `originals/${mediaId}/source${ext}`,
  previewPrefix: (mediaId: string) => `previews/${mediaId}`,
  hlsDir: (mediaId: string) => `previews/${mediaId}/hls`,
  hlsPlaylist: (mediaId: string) => `previews/${mediaId}/hls/index.m3u8`,
  previewImage: (mediaId: string) => `previews/${mediaId}/preview.jpg`,
  thumbnail: (mediaId: string) => `previews/${mediaId}/thumb.jpg`,
};

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
