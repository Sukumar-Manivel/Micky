import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, type Queue, UnrecoverableError } from 'bullmq';
import { OrdersService } from './orders.service.js';
import {
  COMMERCE_JOB,
  COMMERCE_QUEUE,
  HOUSEKEEPING_EVERY_MS,
  type RefundJobData,
} from './refunds.constants.js';
import { RefundsService } from './refunds.service.js';

/**
 * Consumer of the `commerce` queue. It runs inside the API process (the work is a few
 * HTTP calls to the gateway and small transactions, nothing heavy like FFmpeg), so the
 * worker process does not need the payment provider or its secrets.
 *
 * Several API instances can run it at once: BullMQ hands each job to one consumer,
 * refund jobs are deduplicated by job id, and every step is idempotent anyway.
 */
@Processor(COMMERCE_QUEUE)
export class CommerceProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(CommerceProcessor.name);

  constructor(
    private readonly refunds: RefundsService,
    private readonly orders: OrdersService,
    @InjectQueue(COMMERCE_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    // Idempotent: restarts and several API instances still leave exactly one schedule.
    try {
      await this.queue.upsertJobScheduler(
        COMMERCE_JOB.housekeeping,
        { every: HOUSEKEEPING_EVERY_MS },
        {
          name: COMMERCE_JOB.housekeeping,
          opts: { removeOnComplete: 10, removeOnFail: 50 },
        },
      );
    } catch (err) {
      this.logger.error(
        `Could not schedule commerce housekeeping: ${String(err)}`,
      );
    }
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case COMMERCE_JOB.refund: {
        const { paymentId } = job.data as RefundJobData;
        // attemptsMade counts the attempts that already failed (0 during the first run).
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        return {
          outcome: await this.refunds.process(paymentId, { finalAttempt }),
        };
      }
      case COMMERCE_JOB.housekeeping:
        return {
          expired: await this.orders.expireStaleCheckouts(),
          requeued: await this.refunds.requeueStuck(),
          legacy: await this.refunds.remediateLegacyFailedPayments(),
        };
      default:
        throw new UnrecoverableError(`Unknown job ${job.name}`);
    }
  }
}
