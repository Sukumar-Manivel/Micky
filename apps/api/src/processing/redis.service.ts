import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../config/app-config.js';

/**
 * One small Redis connection for our own keys (not BullMQ's), connected on first use:
 * - single-use download links (StreamService, `SET ... NX`);
 * - the index of cached preview renditions (PreviewRenderProcessor).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private connection?: Redis;

  constructor(private readonly config: AppConfig) {}

  get client(): Redis {
    this.connection ??= new Redis(this.config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    return this.connection;
  }

  async onModuleDestroy() {
    await this.connection?.quit().catch(() => undefined);
  }
}
