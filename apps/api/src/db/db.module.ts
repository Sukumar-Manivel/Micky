import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { AppConfig } from '../config/app-config.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/** Injection token for the Drizzle database instance. Use with @InjectDb(). */
export const DB = Symbol('DB');
export const InjectDb = () => Inject(DB);

/** Injection token for the raw pg Pool (rarely needed directly). */
export const PG_POOL = Symbol('PG_POOL');

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

/**
 * Global database module. Any provider can inject the database with
 * `constructor(@InjectDb() private readonly db: Database) {}`.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new pg.Pool({ connectionString: config.databaseUrl, max: config.databasePoolSize }),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Database => drizzle(pool, { schema }),
    },
    PoolCloser,
  ],
  exports: [DB, PG_POOL],
})
export class DbModule {}
