// Names and settings shared by the producer (API process) and the consumer (worker process).
import type { JobsOptions } from 'bullmq';

/** The BullMQ queue (a set of Redis keys) that holds media processing jobs. */
export const MEDIA_QUEUE = 'media-processing';

export const JOB = {
  /** Process one upload: data `{ mediaId }`, job id = mediaId. */
  processMedia: 'process-media',
  /** Repeated every few minutes: refresh trend scores of active incidents. */
  recomputeTrends: 'recompute-trends',
} as const;

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
