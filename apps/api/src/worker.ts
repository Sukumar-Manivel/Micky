// Entry point of the background worker process: `npm run dev:worker` / `npm run start:worker`.
// It runs next to the API (same code, same database and Redis) but never serves HTTP.
import { Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { MediaProcessor } from './processing/media.processor.js';
import { PreviewRenderProcessor } from './processing/preview-render.processor.js';
import { ProcessingScheduler } from './processing/processing.scheduler.js';
import { createWorkerContext } from './worker.module.js';

// Load .env in development (Node 22 built-in), like main.ts.
if (existsSync('.env')) process.loadEnvFile('.env');

if (process.env.NODE_ENV !== 'test') {
  const app = await createWorkerContext();
  const scheduler = app.get(ProcessingScheduler);
  await scheduler.scheduleTrendRecompute();
  await scheduler.schedulePruneRenditions();
  await scheduler.requeueStuck();
  await scheduler.queueMissingDeliveries();
  // Two consumers, one FFmpeg job each (2-core VM): uploads (WORKER_CONCURRENCY, default 1)
  // and per-newsroom preview renditions (always 1), so a newsroom never waits behind an upload.
  app.get(MediaProcessor).start();
  app.get(PreviewRenderProcessor).start();
  new Logger('Worker').log('Worker started, waiting for media processing and preview render jobs');
}
