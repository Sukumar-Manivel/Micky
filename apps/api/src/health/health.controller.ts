import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Public } from '../common/auth.decorators.js';
import { type Database, InjectDb } from '../db/db.module.js';

@Controller('health')
export class HealthController {
  constructor(@InjectDb() private readonly db: Database) {}

  /** Used by Docker health checks and uptime monitors. */
  @Public()
  @Get()
  async check() {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
    return { status: 'ok', database: 'up', time: new Date().toISOString() };
  }
}
