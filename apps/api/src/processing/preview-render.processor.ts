import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { type Database, InjectDb } from '../db/db.module.js';
import { media } from '../db/schema.js';
import { StorageService } from '../storage/storage.service.js';
import { MediaProcessingService } from './media-processing.service.js';
import { previewKeys } from './preview-plan.js';
import { RedisService } from './redis.service.js';
import {
  PREVIEW_JOB,
  PREVIEW_QUEUE,
  RENDITION_TTL_MS,
  RENDITIONS_INDEX_KEY,
  type RenderViewerJobData,
} from './processing.constants.js';

/**
 * Consumer of PREVIEW_QUEUE: renders one newsroom's marked preview at a time
 * (concurrency 1, next to the one media-processing job: two FFmpeg processes on a
 * 2-core VM). Registered only in WorkerModule; started by src/worker.ts.
 */
@Processor(PREVIEW_QUEUE, { autorun: false, concurrency: 1 })
export class PreviewRenderProcessor extends WorkerHost {
  private readonly logger = new Logger(PreviewRenderProcessor.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly redis: RedisService,
    private readonly processing: MediaProcessingService,
    private readonly storage: StorageService,
  ) {
    super();
  }

  start(): void {
    this.worker.run().catch((err: Error) => this.logger.error(`Preview worker stopped: ${err.message}`));
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case PREVIEW_JOB.renderViewer: {
        const { mediaId, viewerId } = job.data as RenderViewerJobData;
        const rendered = await this.processing.renderViewerPreview(mediaId, viewerId);
        if (!rendered) throw new UnrecoverableError('nothing to render');
        await this.redis.client.zadd(RENDITIONS_INDEX_KEY, Date.now(), `${mediaId}/${viewerId}`);
        return { rendered };
      }
      case PREVIEW_JOB.pruneRenditions:
        return { deleted: await this.pruneRenditions() };
      default:
        throw new UnrecoverableError(`Unknown job ${job.name}`);
    }
  }

  /**
   * Deletes cached renditions older than RENDITION_TTL_MS (the next view renders a
   * fresh one) and every rendition of media that was removed or sold exclusively
   * (previews stop for other newsrooms then anyway).
   */
  async pruneRenditions(now = Date.now()): Promise<number> {
    const client = this.redis.client;
    const all = await client.zrange(RENDITIONS_INDEX_KEY, '0', '-1', 'WITHSCORES');
    const entries: { member: string; mediaId: string; viewerId: string; at: number }[] = [];
    for (let i = 0; i < all.length; i += 2) {
      const [mediaId, viewerId] = all[i].split('/');
      entries.push({ member: all[i], mediaId, viewerId, at: Number(all[i + 1]) });
    }
    const ids = [...new Set(entries.map((e) => e.mediaId))];
    const rows = ids.length
      ? await this.db
          .select({ id: media.id, status: media.status, exclusiveSold: media.exclusiveSold })
          .from(media)
          .where(inArray(media.id, ids))
      : [];
    const closed = new Set(rows.filter((m) => m.status === 'REMOVED' || m.exclusiveSold).map((m) => m.id));
    let deleted = 0;
    for (const e of entries) {
      if (e.at > now - RENDITION_TTL_MS && !closed.has(e.mediaId)) continue;
      await this.storage.deletePrefix(previewKeys.viewerDir(e.mediaId, e.viewerId));
      await client.zrem(RENDITIONS_INDEX_KEY, e.member);
      deleted++;
    }
    if (deleted) this.logger.log(`Pruned ${deleted} cached preview rendition(s)`);
    return deleted;
  }
}
