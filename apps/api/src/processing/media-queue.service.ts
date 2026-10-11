import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JOB, MEDIA_QUEUE, PROCESS_JOB_OPTIONS, type ProcessMediaJobData } from './processing.constants.js';

/**
 * The producer side of the queue. The API process only ever calls `enqueue`;
 * the work itself happens in the separate worker process (src/worker.ts).
 */
@Injectable()
export class MediaQueue {
  constructor(@InjectQueue(MEDIA_QUEUE) private readonly queue: Queue<ProcessMediaJobData>) {}

  /**
   * Adds a processing job for one media item. The job id is the media id, so
   * calling this twice for the same media is harmless: BullMQ ignores a job
   * whose id already exists (deduplication).
   */
  async enqueue(mediaId: string): Promise<void> {
    await this.queue.add(JOB.processMedia, { mediaId }, { ...PROCESS_JOB_OPTIONS, jobId: mediaId });
  }
}
