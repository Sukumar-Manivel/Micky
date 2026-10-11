import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  JOB,
  MEDIA_QUEUE,
  PREVIEW_JOB,
  PREVIEW_QUEUE,
  PROCESS_JOB_OPTIONS,
  type ProcessMediaJobData,
  RENDER_JOB_OPTIONS,
  type RenderViewerJobData,
} from './processing.constants.js';

/**
 * The producer side of the queue. The API process only ever calls `enqueue`;
 * the work itself happens in the separate worker process (src/worker.ts).
 */
@Injectable()
export class MediaQueue {
  constructor(
    @InjectQueue(MEDIA_QUEUE) private readonly queue: Queue<ProcessMediaJobData>,
    @InjectQueue(PREVIEW_QUEUE) private readonly previews: Queue<RenderViewerJobData>,
  ) {}

  /**
   * Adds a processing job for one media item. The job id is the media id, so
   * calling this twice for the same media is harmless: BullMQ ignores a job
   * whose id already exists (deduplication).
   */
  async enqueue(mediaId: string): Promise<void> {
    await this.queue.add(JOB.processMedia, { mediaId }, { ...PROCESS_JOB_OPTIONS, jobId: mediaId });
  }

  /** Asks the worker to (re)build the buyer's delivery copy. Deduplicated per media. */
  async enqueueDelivery(mediaId: string): Promise<void> {
    await this.queue.add(JOB.prepareDelivery, { mediaId }, { ...PROCESS_JOB_OPTIONS, jobId: `delivery-${mediaId}` });
  }

  /**
   * Asks the worker to render one newsroom's marked preview, and returns the job so
   * the caller can watch its state. Deduplicated per (media, viewer): two tabs opening
   * the same preview share one render.
   */
  async enqueueViewerRender(mediaId: string, viewerId: string) {
    return this.previews.add(
      PREVIEW_JOB.renderViewer,
      { mediaId, viewerId },
      { ...RENDER_JOB_OPTIONS, jobId: `render-${mediaId}-${viewerId}` },
    );
  }
}
