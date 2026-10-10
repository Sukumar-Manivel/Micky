import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard, RolesGuard } from './common/auth.guards.js';
import { SigningModule } from './common/signing.service.js';
import { UrlModule } from './common/urls.service.js';
import { AppConfig, AppConfigModule } from './config/app-config.js';
import { DbModule } from './db/db.module.js';
import { EarningsModule } from './earnings/earnings.module.js';
import { HealthController } from './health/health.controller.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { MarketModule } from './market/market.module.js';
import { MediaModule } from './media/media.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { ProcessingModule } from './processing/processing.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { StorageModule } from './storage/storage.service.js';
import { StreamModule } from './stream/stream.module.js';

/** Root module of the HTTP API process. The worker process uses WorkerModule instead. */
@Module({
  imports: [
    // Infrastructure (global)
    AppConfigModule,
    DbModule,
    SigningModule,
    UrlModule,
    StorageModule,
    BullModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ connection: { url: config.redisUrl } }),
    }),
    // 100 requests per minute per IP by default; stricter limits on auth routes.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),

    // Features
    AuthModule,
    IncidentsModule,
    RealtimeModule,
    MediaModule,
    ProcessingModule,
    MarketModule,
    StreamModule,
    OrdersModule,
    EarningsModule,
    AdminModule,
    ReportsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limit, then authenticate, then check roles.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
