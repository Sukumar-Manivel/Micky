import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MediaQueue } from './media-queue.service.js';
import { MEDIA_QUEUE } from './processing.constants.js';

/**
 * Producer side of media processing, imported by both processes:
 * - AppModule (HTTP API) and MediaModule use `MediaQueue.enqueue` after an upload.
 * - WorkerModule imports it too, for the queue handle (re-queueing stuck jobs,
 *   scheduling the trend job).
 *
 * The consumer (`MediaProcessor`) is deliberately NOT here: it is registered only
 * in WorkerModule, so the API process never runs FFmpeg.
 */
@Module({
  imports: [BullModule.registerQueue({ name: MEDIA_QUEUE })],
  providers: [MediaQueue],
  exports: [MediaQueue, BullModule],
})
export class ProcessingModule {}
