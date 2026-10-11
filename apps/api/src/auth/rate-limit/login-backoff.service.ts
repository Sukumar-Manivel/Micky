import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { AppConfig } from '../../config/app-config.js';
import { InjectRateLimitRedis, RATE_LIMIT_PREFIX } from './redis.provider.js';

/** 429 with the number of seconds to wait; the controller turns it into a Retry-After header. */
export class LoginBackoffException extends HttpException {
  constructor(readonly retryAfterSec: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: `Too many failed attempts for this account. Try again in ${describeWait(retryAfterSec)}.`,
        retryAfterSec,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Exponential backoff per account (per email address), shared by every API process in Redis.
 *
 * The per-IP throttle stops one machine guessing fast. It does not stop a botnet trying a few
 * passwords each from thousands of IPs against one account. This does:
 * - the first LOGIN_FREE_ATTEMPTS failures in an hour cost nothing (typos);
 * - each further failure locks the email for base × 2^n seconds, capped at LOGIN_BACKOFF_MAX_SEC;
 * - while locked, the password is NOT checked, so guesses during the lock reveal nothing;
 * - a successful login clears the counter.
 *
 * Unknown emails get exactly the same treatment, so the 429 does not reveal which emails exist.
 * Keys are a SHA-256 of the email, so Redis never holds the addresses themselves.
 *
 * Trade-off: anyone can delay a known user's login by failing on purpose. The cap (15 min by
 * default) bounds that; it is a delay, never a permanent lockout.
 */
@Injectable()
export class LoginBackoffService {
  private readonly logger = new Logger(LoginBackoffService.name);
  /** Failures are forgotten this long after the last one. */
  private static readonly WINDOW_SEC = 60 * 60;

  constructor(
    @InjectRateLimitRedis() private readonly redis: Redis,
    private readonly config: AppConfig,
  ) {}

  /** Throws LoginBackoffException if this email is currently locked. Fails open if Redis is down. */
  async assertAllowed(email: string): Promise<void> {
    let msLeft: number;
    try {
      msLeft = await this.redis.pttl(this.lockKey(email));
    } catch (err) {
      this.logger.warn(`Login backoff check skipped (Redis unavailable): ${(err as Error).message}`);
      return;
    }
    if (msLeft > 0) throw new LoginBackoffException(Math.ceil(msLeft / 1000));
  }

  /** Records a failed attempt; returns the lock length in seconds (0 if none was set). */
  async recordFailure(email: string): Promise<number> {
    try {
      const failKey = this.failKey(email);
      const [[, failures]] = (await this.redis
        .multi()
        .incr(failKey)
        .expire(failKey, LoginBackoffService.WINDOW_SEC)
        .exec()) as [[Error | null, number], [Error | null, number]];
      const lockSec = this.lockSecondsFor(failures);
      if (lockSec > 0) await this.redis.set(this.lockKey(email), '1', 'EX', lockSec);
      return lockSec;
    } catch (err) {
      this.logger.warn(`Could not record a failed login (Redis unavailable): ${(err as Error).message}`);
      return 0;
    }
  }

  async recordSuccess(email: string): Promise<void> {
    await this.redis.del(this.failKey(email), this.lockKey(email)).catch(() => undefined);
  }

  /** 0 for the first LOGIN_FREE_ATTEMPTS failures, then base, 2×base, 4×base … up to the cap. */
  lockSecondsFor(failures: number): number {
    const over = failures - this.config.loginFreeAttempts - 1;
    if (over < 0) return 0;
    const seconds = this.config.loginBackoffBaseSec * 2 ** Math.min(over, 20);
    return Math.min(seconds, this.config.loginBackoffMaxSec);
  }

  private failKey(email: string) {
    return `${RATE_LIMIT_PREFIX}login:fail:${emailHash(email)}`;
  }

  private lockKey(email: string) {
    return `${RATE_LIMIT_PREFIX}login:lock:${emailHash(email)}`;
  }
}

function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
