import { Global, Injectable, Module } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppConfig } from '../config/app-config.js';
import { SigningService } from './signing.service.js';

/** Token purposes and payloads. Routes that accept a token verify the same purpose. */
export const TOKEN = {
  thumb: 'thumb', //    { m: mediaId }
  stream: 'stream', //  { m: mediaId, u: userId }
  download: 'download', // { o: orderId, u: buyerId, n: nonce }
} as const;

export const STREAM_TTL_SEC = 10 * 60;
/** Download links are single-use and must be redeemed quickly (review M3). */
export const DOWNLOAD_TTL_SEC = 120;

/** Builds the absolute, signed URLs the API hands out to browsers. */
@Injectable()
export class UrlService {
  constructor(
    private readonly config: AppConfig,
    private readonly signing: SigningService,
  ) {}

  private get base() {
    return `${this.config.publicApiUrl}/api/v1`;
  }

  /**
   * Signed thumbnail URL, valid at least one hour. The expiry is rounded to the
   * hour so the same URL is returned for an hour and browsers can cache the image.
   */
  thumbnailUrl(item: { id: string; thumbKey: string | null }): string | null {
    if (!item.thumbKey) return null;
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.ceil(now / 3600) * 3600 + 3600 - now;
    return `${this.base}/files/thumb/${this.signing.sign(TOKEN.thumb, { m: item.id }, ttl)}`;
  }

  /** Base URL for one preview session; append "index.m3u8" or "image.jpg". */
  streamBase(mediaId: string, userId: string): { base: string; expiresAt: Date } {
    const token = this.signing.sign(TOKEN.stream, { m: mediaId, u: userId }, STREAM_TTL_SEC);
    return { base: `${this.base}/stream/${token}/`, expiresAt: new Date(Date.now() + STREAM_TTL_SEC * 1000) };
  }

  /**
   * Single-use download link bound to the buyer. The random nonce makes every link
   * unique, so two clicks in the same second don't produce the same (already used) link.
   */
  downloadUrl(orderId: string, buyerId: string): { url: string; expiresAt: Date } {
    const payload = { o: orderId, u: buyerId, n: randomBytes(9).toString('base64url') };
    const token = this.signing.sign(TOKEN.download, payload, DOWNLOAD_TTL_SEC);
    return {
      url: `${this.base}/files/download/${token}`,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SEC * 1000),
    };
  }
}

@Global()
@Module({ providers: [UrlService], exports: [UrlService] })
export class UrlModule {}
