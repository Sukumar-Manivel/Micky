import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../../config/app-config.js';

/** Injection token for the Redis client used by rate limiting and login backoff. */
export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');
export const InjectRateLimitRedis = () => Inject(RATE_LIMIT_REDIS);

/** Every key this module writes starts with this, so tests and operators can find them. */
export const RATE_LIMIT_PREFIX = 'ff:rl:';

export function createRateLimitRedis(config: AppConfig): Redis {
  const logger = new Logger('RateLimitRedis');
  const client = new Redis(config.redisUrl, {
    // Fail a command quickly while Redis is down instead of letting HTTP requests hang;
    // callers then fail open (see RedisThrottlerStorage and LoginBackoffService).
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    lazyConnect: false,
  });
  let lastError = 0;
  client.on('error', (err: Error) => {
    // Log at most once a minute: a Redis outage would otherwise flood the logs.
    if (Date.now() - lastError > 60_000) {
      lastError = Date.now();
      logger.error(`Redis error (rate limits fail open until it is back): ${err.message}`);
    }
  });
  return client;
}

/** Closes the rate-limit Redis connection when the app shuts down. */
@Injectable()
export class RateLimitRedisCloser implements OnApplicationShutdown {
  constructor(@InjectRateLimitRedis() private readonly redis: Redis) {}
  async onApplicationShutdown() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
