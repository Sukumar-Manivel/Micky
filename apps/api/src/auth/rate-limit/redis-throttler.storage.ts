import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { InjectRateLimitRedis, RATE_LIMIT_PREFIX } from './redis.provider.js';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Atomic fixed-window counter with a block, in one round trip.
 * KEYS[1] = hit counter, KEYS[2] = block marker.
 * ARGV = ttl ms, limit, block duration ms.
 * Returns { hits, ms until the window resets, blocked 0/1, ms until the block ends }.
 * Same behaviour as @nestjs/throttler's in-memory storage: once hits pass the limit the key
 * is blocked for blockDuration (default: ttl), and a new window starts after the block.
 */
const INCREMENT_SCRIPT = `
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {hits, blockLeft, 1, blockLeft}
end
local hits = redis.call('INCR', KEYS[1])
local left = redis.call('PTTL', KEYS[1])
if left < 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
  left = ttl
end
if hits > limit then
  if block > 0 then
    redis.call('SET', KEYS[2], '1', 'PX', block)
    redis.call('DEL', KEYS[1])
    return {hits, block, 1, block}
  end
  return {hits, left, 1, left}
end
return {hits, left, 0, 0}
`;

/**
 * Throttler storage in Redis, so limits hold across API processes and restarts
 * (the default in-memory storage is per process: two API containers = double the limit,
 * and every deploy resets the counters). docs/REVIEW.md L2.
 *
 * Fails open: if Redis is unreachable a request is allowed and an error is logged.
 * Locking every user out because the queue database blinked would be worse.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  /** Part of every key; see onApplicationShutdown(). Always 0 in a running server. */
  private generation = 0;

  constructor(@InjectRateLimitRedis() private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${RATE_LIMIT_PREFIX}t${this.generation}:${throttlerName}:${key}`;
    try {
      const [hits, msLeft, blocked, msBlock] = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        `${base}:hits`,
        `${base}:block`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(msLeft / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(msBlock / 1000),
      };
    } catch (err) {
      this.logger.warn(`Rate limit check skipped (Redis unavailable): ${(err as Error).message}`);
      return { totalHits: 0, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  /** Deletes every rate-limit and login-backoff key. For tests only. */
  async reset(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${RATE_LIMIT_PREFIX}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  /**
   * Nest calls this once at shutdown, when it no longer matters. Some e2e fixtures also call it
   * directly, synchronously, to "clear" the counters (that is what it does for the in-memory
   * storage). Switching to a new key generation has the same effect without waiting for Redis;
   * the old keys expire on their own. The connection is closed by RateLimitRedisCloser.
   */
  onApplicationShutdown(): void {
    this.generation += 1;
  }
}
