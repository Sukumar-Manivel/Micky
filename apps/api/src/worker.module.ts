import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfig, AppConfigModule } from './config/app-config.js';
import { DbModule } from './db/db.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { MediaProcessingService } from './processing/media-processing.service.js';
import { MediaProcessor } from './processing/media.processor.js';
import { ProcessingModule } from './processing/processing.module.js';
import { ProcessingScheduler } from './processing/processing.scheduler.js';
import { VerifierClient } from './processing/verifier.client.js';
import { StorageModule } from './storage/storage.service.js';

/**
 * Root module of the background worker process (src/worker.ts).
 *
 * No HTTP server, no controllers, no auth: just the database, storage, Redis
 * and the queue consumer. RealtimeModule is not imported, so IncidentsService
 * gets no RealtimeService (it is @Optional) and simply does not emit events.
 */
@Module({
  imports: [
    AppConfigModule,
    DbModule,
    StorageModule,
    BullModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ connection: { url: config.redisUrl } }),
    }),
    IncidentsModule,
    ProcessingModule,
  ],
  providers: [VerifierClient, MediaProcessingService, MediaProcessor, ProcessingScheduler],
})
export class WorkerModule {}

/** Creates the worker's Nest application context (without starting to consume jobs). */
export async function createWorkerContext() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: process.env.NODE_ENV === 'test' ? ['error'] : undefined,
  });
  app.enableShutdownHooks();
  return app;
}
