// Names and settings shared by the producer (API process) and the consumer (worker process).
import type { JobsOptions } from 'bullmq';

/** The BullMQ queue (a set of Redis keys) that holds media processing jobs. */
export const MEDIA_QUEUE = 'media-processing';

export const JOB = {
  /** Process one upload: data `{ mediaId }`, job id = mediaId. */
  processMedia: 'process-media',
  /** Repeated every few minutes: refresh trend scores of active incidents. */
  recomputeTrends: 'recompute-trends',
  /** Make the buyer's metadata-free copy of one media: data `{ mediaId }`, job id = `delivery-<mediaId>`. */
  prepareDelivery: 'prepare-delivery',
} as const;

/**
 * A second queue for per-newsroom preview renditions. Separate from MEDIA_QUEUE so a
 * newsroom opening a preview never waits behind a 10-minute upload being processed;
 * the worker runs one job of each queue at a time (2 FFmpeg processes on 2 cores).
 */
export const PREVIEW_QUEUE = 'preview-render';

export const PREVIEW_JOB = {
  /** Burn one newsroom's name into one media's preview: data `{ mediaId, viewerId }`. */
  renderViewer: 'render-viewer-preview',
  /** Daily: delete renditions nobody opened for RENDITION_TTL_MS, and those of sold/removed media. */
  pruneRenditions: 'prune-renditions',
} as const;

export interface RenderViewerJobData {
  mediaId: string;
  viewerId: string;
}

/** Cached per-newsroom renditions are deleted after this long (they are re-rendered on the next view). */
export const RENDITION_TTL_MS = 7 * 24 * 3_600_000;
export const PRUNE_RENDITIONS_EVERY_MS = 24 * 3_600_000;
/** Redis sorted set: member "<mediaId>/<viewerId>", score = last render time. */
export const RENDITIONS_INDEX_KEY = 'micky:preview-renditions';

/** Render jobs are short-lived: failed or finished ones disappear quickly, so the next view can retry. */
export const RENDER_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 30 },
  removeOnFail: { age: 30 },
  priority: 1,
};

export interface ProcessMediaJobData {
  mediaId: string;
}

/** How often the worker refreshes trend scores (trend decays with time, so it must be recomputed). */
export const TREND_RECOMPUTE_EVERY_MS = 5 * 60_000;

/**
 * Retries: 4 attempts with exponential backoff (15 s, 30 s, 60 s between them),
 * so a verifier restart or a brief storage outage does not fail an upload.
 * Finished jobs are kept for a while for debugging, then removed so Redis does not grow forever.
 */
export const PROCESS_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 15_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Media still PROCESSING after this long, with no job in Redis, is re-queued when the worker starts. */
export const STUCK_AFTER_MS = 2 * 60_000;
