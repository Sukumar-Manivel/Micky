import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { AppConfig } from '../config/app-config.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { GENERIC_FAILURE_MESSAGE, PermanentProcessingError } from './errors.js';
import { MediaProcessingService } from './media-processing.service.js';
import { JOB, MEDIA_QUEUE, type ProcessMediaJobData } from './processing.constants.js';

/**
 * The BullMQ consumer. Registered only in WorkerModule, so it runs in the worker
 * process and never in the HTTP API.
 *
 * `autorun: false`: the worker starts pulling jobs only when `start()` is called
 * (by src/worker.ts). Tests can build the same module and call the service
 * directly without a background consumer racing them.
 */
@Processor(MEDIA_QUEUE, { autorun: false })
export class MediaProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MediaProcessor.name);

  constructor(
    private readonly processing: MediaProcessingService,
    private readonly incidents: IncidentsService,
    private readonly config: AppConfig,
  ) {
    super();
  }

  onApplicationBootstrap() {
    // How many jobs this process runs at once. FFmpeg uses several cores per job,
    // so on a small server 1 is right; scale out with more worker processes instead.
    this.worker.concurrency = Math.max(1, this.config.workerConcurrency);
  }

  /** Starts consuming jobs. Resolves immediately; the worker runs until the app shuts down. */
  start(): void {
    this.worker.run().catch((err: Error) => this.logger.error(`Worker stopped: ${err.message}`));
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB.processMedia:
        return this.processMedia(job as Job<ProcessMediaJobData>);
      case JOB.recomputeTrends:
        return { incidents: await this.incidents.recomputeActive() };
      default:
        throw new UnrecoverableError(`Unknown job ${job.name}`);
    }
  }

  private async processMedia(job: Job<ProcessMediaJobData>) {
    const { mediaId } = job.data;
    // attemptsMade counts the attempts that already failed (0 during the first run).
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      return { outcome: await this.processing.process(mediaId, { finalAttempt }) };
    } catch (err) {
      const error = err as Error;
      if (error instanceof PermanentProcessingError) {
        await this.processing.markFailed(mediaId, error.message);
        // UnrecoverableError tells BullMQ not to retry: the file will not get better.
        throw new UnrecoverableError(error.message);
      }
      this.logger.warn(
        `Media ${mediaId} attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1} failed: ${error.message}`,
      );
      if (finalAttempt) await this.processing.markFailed(mediaId, GENERIC_FAILURE_MESSAGE);
      throw error; // BullMQ schedules the next attempt with exponential backoff
    }
  }

  /**
   * Safety net for failures that never reach `process`' catch block, e.g. a job
   * that "stalled" too often because the worker crashed mid-job.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessMediaJobData> | undefined, error: Error) {
    if (!job || job.name !== JOB.processMedia) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError;
    if (!exhausted) return;
    // A broken file is the uploader's problem (warn); anything else is ours (error).
    const message = `Media ${job.data.mediaId} failed permanently: ${error.message}`;
    if (error instanceof UnrecoverableError) this.logger.warn(message);
    else this.logger.error(message);
    // markFailed only changes media that is still PROCESSING, so this is a no-op if already FAILED.
    await this.processing.markFailed(job.data.mediaId, GENERIC_FAILURE_MESSAGE).catch(() => undefined);
  }
}
