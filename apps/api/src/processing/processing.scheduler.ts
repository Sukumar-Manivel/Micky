import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import { type Database, InjectDb } from '../db/db.module.js';
import { media } from '../db/schema.js';
import { MediaQueue } from './media-queue.service.js';
import { JOB, MEDIA_QUEUE, STUCK_AFTER_MS, TREND_RECOMPUTE_EVERY_MS } from './processing.constants.js';

/** Housekeeping the worker does when it starts. Registered only in WorkerModule. */
@Injectable()
export class ProcessingScheduler {
  private readonly logger = new Logger(ProcessingScheduler.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @InjectQueue(MEDIA_QUEUE) private readonly queue: Queue,
    private readonly mediaQueue: MediaQueue,
  ) {}

  /**
   * Trend scores decay with time even when nothing happens, so they are recomputed
   * every 5 minutes. `upsertJobScheduler` is idempotent: running several workers,
   * or restarting one, still leaves exactly one schedule in Redis.
   */
  async scheduleTrendRecompute(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB.recomputeTrends,
      { every: TREND_RECOMPUTE_EVERY_MS },
      { name: JOB.recomputeTrends, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
  }

  /**
   * Re-queues uploads stuck in PROCESSING (e.g. Redis lost its data, or the API
   * crashed between saving the row and enqueueing). Safe to run any time: the job
   * id is the media id, so media whose job still exists is not queued twice.
   */
  async requeueStuck(): Promise<number> {
    const stuck = await this.db
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.status, 'PROCESSING'), lt(media.createdAt, new Date(Date.now() - STUCK_AFTER_MS))));
    for (const { id } of stuck) await this.mediaQueue.enqueue(id);
    if (stuck.length) this.logger.log(`Re-queued ${stuck.length} media stuck in PROCESSING`);
    return stuck.length;
  }
}
