import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { type Database, InjectDb } from '../db/db.module.js';
import { orders, refunds } from '../db/schema.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from './payments/payment-provider.js';
import {
  COMMERCE_JOB,
  COMMERCE_QUEUE,
  REFUND_JOB_OPTIONS,
  REFUND_STUCK_AFTER_MS,
  type RefundJobData,
  refundJobId,
} from './refunds.constants.js';

export type RefundRow = typeof refunds.$inferSelect;
type Tx = Pick<Database, 'insert'>;

export interface RefundRequest {
  orderId: string;
  provider: string;
  paymentId: string;
  /** Paise actually captured for this payment. */
  amount: number;
  /** Why the money goes back, e.g. "The exclusive licence was sold to another newsroom". */
  reason: string;
}

export type RefundJobOutcome = 'processed' | 'pending' | 'failed' | 'skipped';

/**
 * Money that was captured but must go back to the buyer (review H1):
 * - a payment that lost the race for an exclusive licence, or arrived for media that was
 *   taken down, or for an expired checkout;
 * - a second payment for an order that was already paid;
 * - a payment of the wrong amount or currency.
 *
 * The flow is "record, then act":
 * 1. `record()` inserts a `refunds` row in the SAME transaction that decides the money
 *    cannot be kept. The unique `provider_payment_id` makes this idempotent.
 * 2. After commit, `enqueue()` adds a BullMQ job whose id is derived from the payment id.
 * 3. `process()` (run by CommerceProcessor) calls the gateway's refund API, which is
 *    itself idempotent (it finds an earlier refund with our receipt), and stores the
 *    gateway's refund id. Failures are retried with backoff; after the last attempt the
 *    refund is FAILED and waits for an admin to press "Retry".
 *
 * If Redis loses the job, housekeeping re-queues PENDING refunds (`requeueStuck`).
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @InjectQueue(COMMERCE_QUEUE) private readonly queue: Queue<RefundJobData>,
  ) {}

  /** Records that a payment must be refunded. Call inside the transaction that decided it. */
  async record(tx: Tx, request: RefundRequest): Promise<void> {
    await tx
      .insert(refunds)
      .values({
        orderId: request.orderId,
        provider: request.provider,
        providerPaymentId: request.paymentId,
        amount: request.amount,
        reason: request.reason,
      })
      .onConflictDoNothing({ target: refunds.providerPaymentId });
  }

  /** Adds the refund job. Never throws: if Redis is down, housekeeping re-queues it later. */
  async enqueue(paymentId: string): Promise<void> {
    try {
      await this.queue.add(
        COMMERCE_JOB.refund,
        { paymentId },
        { ...REFUND_JOB_OPTIONS, jobId: refundJobId(paymentId) },
      );
    } catch (err) {
      this.logger.error(
        `Could not queue the refund of payment ${paymentId} (housekeeping will retry): ${String(err)}`,
      );
    }
  }

  /** The job body. Safe to run any number of times for the same payment. */
  async process(
    paymentId: string,
    opts: { finalAttempt: boolean },
  ): Promise<RefundJobOutcome> {
    const refund = await this.db.query.refunds.findFirst({
      where: eq(refunds.providerPaymentId, paymentId),
    });
    // PROCESSED: done. FAILED: waits for an admin's retry, which sets it back to PENDING.
    if (!refund || refund.status !== 'PENDING') return 'skipped';
    if (refund.provider !== this.provider.name) {
      await this.markFailed(
        paymentId,
        `This payment was taken by "${refund.provider}" but the API now runs "${this.provider.name}"`,
      );
      return 'failed';
    }

    await this.db
      .update(refunds)
      .set({ attempts: sql`${refunds.attempts} + 1` })
      .where(eq(refunds.id, refund.id));

    let result;
    try {
      result = await this.provider.refund({
        paymentId,
        amountPaise: refund.amount,
        receipt: refund.id,
        notes: { orderId: refund.orderId, refundId: refund.id },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (opts.finalAttempt) await this.markFailed(paymentId, message);
      else
        await this.db
          .update(refunds)
          .set({ lastError: message })
          .where(eq(refunds.id, refund.id));
      throw err; // BullMQ retries with backoff (or gives up after the final attempt)
    }

    if (result.status === 'processed') {
      await this.markProcessed(paymentId, result.refundId);
      return 'processed';
    }
    if (result.status === 'failed') {
      await this.markFailed(
        paymentId,
        'The payment gateway reported the refund as failed',
        result.refundId,
      );
      return 'failed';
    }
    // Accepted by the gateway; Razorpay reports completion with the refund.processed webhook.
    await this.db
      .update(refunds)
      .set({ providerRefundId: result.refundId, lastError: null })
      .where(eq(refunds.id, refund.id));
    this.logger.log(
      `Refund ${result.refundId} of payment ${paymentId} accepted, waiting for the gateway`,
    );
    return 'pending';
  }

  /**
   * The gateway finished a refund we asked for (job result or `refund.processed` webhook).
   * Returns false if we never asked to refund this payment (then it is an external refund,
   * made in the Razorpay dashboard, and the caller reverses the sale instead).
   */
  async markProcessed(
    paymentId: string,
    providerRefundId: string | null,
  ): Promise<boolean> {
    const result = await this.db.transaction(async (tx) => {
      const [refund] = await tx
        .select()
        .from(refunds)
        .where(eq(refunds.providerPaymentId, paymentId))
        .for('update');
      if (!refund) return { known: false as const };
      if (refund.status === 'PROCESSED')
        return { known: true as const, changed: false };
      await tx
        .update(refunds)
        .set({
          status: 'PROCESSED',
          providerRefundId: providerRefundId ?? refund.providerRefundId,
          lastError: null,
          processedAt: new Date(),
        })
        .where(eq(refunds.id, refund.id));
      // The order itself is REFUNDED only if this was the payment it was waiting on
      // (a duplicate payment of a PAID order is refunded without touching the order).
      await tx
        .update(orders)
        .set({ status: 'REFUNDED', refundedAt: new Date() })
        .where(
          and(
            eq(orders.id, refund.orderId),
            eq(orders.providerPaymentId, paymentId),
            inArray(orders.status, ['REFUND_PENDING', 'REFUND_FAILED']),
          ),
        );
      return { known: true as const, changed: true };
    });
    if (result.known && result.changed)
      this.logger.log(
        `Payment ${paymentId} refunded (${providerRefundId ?? 'no refund id'})`,
      );
    return result.known;
  }

  /** Gives up on a refund until an admin retries it. Returns false if it is not ours. */
  async markFailed(
    paymentId: string,
    error: string,
    providerRefundId?: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [refund] = await tx
        .update(refunds)
        .set({
          status: 'FAILED',
          lastError: error.slice(0, 1000),
          ...(providerRefundId ? { providerRefundId } : {}),
        })
        .where(
          and(
            eq(refunds.providerPaymentId, paymentId),
            ne(refunds.status, 'PROCESSED'),
          ),
        )
        .returning();
      if (!refund) {
        const exists = await tx.query.refunds.findFirst({
          where: eq(refunds.providerPaymentId, paymentId),
          columns: { id: true },
        });
        return Boolean(exists);
      }
      await tx
        .update(orders)
        .set({ status: 'REFUND_FAILED' })
        .where(
          and(
            eq(orders.id, refund.orderId),
            eq(orders.providerPaymentId, paymentId),
            eq(orders.status, 'REFUND_PENDING'),
          ),
        );
      this.logger.error(
        `REFUND FAILED for payment ${paymentId}: ${error}. An admin must retry it.`,
      );
      return true;
    });
  }

  /** Admin "Retry": FAILED → PENDING (or a stuck PENDING), then queue the job again. */
  async retry(refundId: string): Promise<RefundRow> {
    const row = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(refunds)
        .where(eq(refunds.id, refundId))
        .for('update');
      if (!current) throw new NotFoundException('Refund not found');
      if (current.status === 'PROCESSED')
        throw new ConflictException('This refund has already been processed');
      const [updated] = await tx
        .update(refunds)
        .set({ status: 'PENDING', lastError: null })
        .where(eq(refunds.id, refundId))
        .returning();
      await tx
        .update(orders)
        .set({ status: 'REFUND_PENDING' })
        .where(
          and(
            eq(orders.id, current.orderId),
            eq(orders.providerPaymentId, current.providerPaymentId),
            eq(orders.status, 'REFUND_FAILED'),
          ),
        );
      return updated;
    });
    // A finished job was removed (removeOnComplete/removeOnFail), so the id is free again.
    await this.enqueue(row.providerPaymentId);
    this.logger.log(
      `Refund ${refundId} (payment ${row.providerPaymentId}) retried by an admin`,
    );
    return row;
  }

  /**
   * Housekeeping: re-queue refunds still PENDING after a while. Covers a job lost by
   * Redis, a crash between commit and enqueue, and a missed `refund.processed` webhook
   * (the gateway call is idempotent and returns the refund's current status).
   */
  async requeueStuck(): Promise<number> {
    const stuck = await this.db
      .select({ paymentId: refunds.providerPaymentId })
      .from(refunds)
      .where(
        and(
          eq(refunds.status, 'PENDING'),
          lt(refunds.updatedAt, new Date(Date.now() - REFUND_STUCK_AFTER_MS)),
        ),
      );
    for (const { paymentId } of stuck) await this.enqueue(paymentId);
    if (stuck.length)
      this.logger.warn(`Re-queued ${stuck.length} stuck refund(s)`);
    return stuck.length;
  }

  /**
   * One-off remediation, safe to run repeatedly: before refunds existed, a payment that
   * lost the licence race was stored as a FAILED order *with* a payment id. Those buyers
   * were charged and never refunded; give each one a refund now.
   */
  async remediateLegacyFailedPayments(): Promise<number> {
    const legacy = await this.db
      .select({
        id: orders.id,
        provider: orders.provider,
        paymentId: orders.providerPaymentId,
        amount: orders.amount,
      })
      .from(orders)
      .leftJoin(
        refunds,
        eq(refunds.providerPaymentId, orders.providerPaymentId),
      )
      .where(
        and(
          eq(orders.status, 'FAILED'),
          isNotNull(orders.providerPaymentId),
          isNull(refunds.id),
        ),
      );
    for (const o of legacy) {
      const paymentId = o.paymentId!;
      await this.db.transaction(async (tx) => {
        const [moved] = await tx
          .update(orders)
          .set({
            status: 'REFUND_PENDING',
            statusReason:
              'The licence was no longer available when the payment arrived',
          })
          .where(and(eq(orders.id, o.id), eq(orders.status, 'FAILED')))
          .returning({ id: orders.id });
        if (!moved) return;
        await this.record(tx, {
          orderId: o.id,
          provider: o.provider,
          paymentId,
          amount: o.amount,
          reason:
            'The licence was no longer available when the payment arrived',
        });
      });
      await this.enqueue(paymentId);
    }
    if (legacy.length)
      this.logger.warn(
        `Started refunds for ${legacy.length} legacy FAILED paid order(s)`,
      );
    return legacy.length;
  }
}
