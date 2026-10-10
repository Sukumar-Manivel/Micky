import { Global, Injectable, Module } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/app-config.js';

/**
 * Creates and checks short-lived signed tokens for URLs that browsers load
 * directly (video segments, thumbnails, downloads), where we cannot attach
 * an Authorization header.
 *
 * Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).
 * The payload always contains `p` (purpose) and `exp` (unix seconds).
 */
@Injectable()
export class SigningService {
  constructor(private readonly config: AppConfig) {}

  sign<T extends Record<string, unknown>>(purpose: string, data: T, ttlSec: number): string {
    const payload = { ...data, p: purpose, exp: Math.floor(Date.now() / 1000) + ttlSec };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.hmac(body)}`;
  }

  /** Returns the payload, or null if the token is malformed, tampered with, expired or for another purpose. */
  verify<T extends Record<string, unknown>>(purpose: string, token: string): (T & { exp: number }) | null {
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;

    const expected = Buffer.from(this.hmac(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & {
        p: string;
        exp: number;
      };
      if (payload.p !== purpose || typeof payload.exp !== 'number') return null;
      if (payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private hmac(body: string): string {
    return createHmac('sha256', this.config.signingSecret).update(body).digest('base64url');
  }
}

@Global()
@Module({ providers: [SigningService], exports: [SigningService] })
export class SigningModule {}
