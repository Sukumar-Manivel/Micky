// Names and settings of the commerce queue (refund jobs and periodic housekeeping).
import type { JobsOptions } from 'bullmq';

export const COMMERCE_QUEUE = 'commerce';

export const COMMERCE_JOB = {
  /** Refund one captured payment: data `{ paymentId }`, job id derived from the payment id. */
  refund: 'refund',
  /** Every few minutes: expire stale checkouts, re-queue refunds whose job got lost. */
  housekeeping: 'commerce-housekeeping',
} as const;

export interface RefundJobData {
  paymentId: string;
}

/** BullMQ job ids may not contain ':'; payment ids never do, but be safe. */
export function refundJobId(paymentId: string): string {
  return `refund-${paymentId.replace(/:/g, '_')}`;
}

/**
 * 6 attempts with exponential backoff (30 s, 1, 2, 4, 8 min): a gateway outage of
 * about a quarter of an hour is absorbed without a human. After that the refund is
 * marked FAILED and shows up in the admin's refund queue with a "Retry" button.
 *
 * Jobs are removed when they finish: the `refunds` table is the source of truth, and
 * removing them lets an admin retry re-use the same job id (BullMQ ignores an add()
 * whose id still exists).
 */
export const REFUND_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

export const HOUSEKEEPING_EVERY_MS = 5 * 60_000;

/** A PENDING refund with no gateway refund id that is older than this gets its job re-queued. */
export const REFUND_STUCK_AFTER_MS = 20 * 60_000;

/**
 * A checkout is expired by housekeeping only this long after `expires_at`, so a payment
 * made at the last second has time to arrive through /verify first. Payments are judged
 * by the time the buyer paid, not by when we hear about them, so this grace only affects
 * how soon the order is shown as EXPIRED.
 */
export const EXPIRY_SWEEP_GRACE_MS = 2 * 60_000;
