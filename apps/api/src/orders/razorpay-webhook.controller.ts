import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { Public } from '../common/auth.decorators.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { webhookEvents } from '../db/schema.js';
import { OrdersService } from './orders.service.js';
import { RefundsService } from './refunds.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from './payments/payment-provider.js';

/** The parts of a Razorpay webhook body we use. Everything else is ignored. */
interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        created_at?: number; // unix seconds
      };
    };
    order?: { entity?: { id?: string } };
    refund?: {
      entity?: {
        id?: string;
        payment_id?: string;
        amount?: number;
        status?: string;
      };
    };
    dispute?: {
      entity?: {
        id?: string;
        payment_id?: string;
        amount?: number;
        reason_code?: string;
      };
    };
  };
}

/**
 * Razorpay calls this URL server-to-server after a payment, even if the buyer closed
 * the browser before our /verify call happened. That makes it the reliable path; the
 * /verify call is just the fast path for a good user experience.
 *
 * Rules for webhook handlers:
 * - Verify the signature over the RAW bytes before trusting anything in the body.
 *   Re-serialising parsed JSON can change spacing or key order and break the HMAC.
 * - Be idempotent: Razorpay retries until it gets a 2xx, so the same event can arrive
 *   several times. We record each event id in `webhook_events` (primary key) together
 *   with the SHA-256 of the signed body (unique). The event-id header is NOT signed, so
 *   the body hash is what stops a captured body being replayed under a new event id.
 *   Every handler is also idempotent on its own, as a second line of defence.
 * - Answer quickly: only small database transactions happen here; refunds run in a job.
 *
 * Events handled: payment.captured / order.paid (grant), payment.failed, refund.processed,
 * refund.failed, payment.dispute.* . Subscribe to exactly these in the Razorpay dashboard.
 */
@Controller('payments/razorpay')
export class RazorpayWebhookController {
  private readonly logger = new Logger(RazorpayWebhookController.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ) {
    const rawBody = req.rawBody;
    if (
      !rawBody ||
      !signature ||
      !this.provider.verifyWebhookSignature(rawBody, signature)
    ) {
      this.logger.warn(
        'Rejected a Razorpay webhook with a missing or invalid signature',
      );
      throw new BadRequestException('Invalid webhook signature');
    }

    // Only now is the body trusted. Nest has already parsed the same bytes as JSON.
    const body = req.body as RazorpayWebhookBody;
    const event = body.event ?? 'unknown';
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    if (!eventId) {
      // Razorpay always sends this header. Without it, the body hash is the key.
      this.logger.warn(
        `Razorpay webhook "${event}" arrived without x-razorpay-event-id`,
      );
    }
    const claimId = eventId?.slice(0, 200) || `sha256:${payloadHash}`;

    // Claim the event. A conflict on either the event id or the body hash means this
    // exact delivery was already processed (a retry, or a replay under a new event id).
    const claimed = await this.db
      .insert(webhookEvents)
      .values({ id: claimId, provider: 'razorpay', type: event, payloadHash })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (claimed.length === 0)
      return { received: true, status: 'already processed' };

    try {
      const status = await this.process(event, body);
      return { received: true, status };
    } catch (err) {
      // Release the claim so Razorpay's retry can process the event, then answer 500.
      await this.db.delete(webhookEvents).where(eq(webhookEvents.id, claimId));
      this.logger.error(
        `Failed to process Razorpay webhook "${event}" (${claimId}): ${String(err)}`,
      );
      throw new InternalServerErrorException('Webhook processing failed');
    }
  }

  private async process(
    event: string,
    body: RazorpayWebhookBody,
  ): Promise<string> {
    const payment = body.payload?.payment?.entity;

    switch (event) {
      case 'order.paid':
      case 'payment.captured': {
        const providerOrderId =
          payment?.order_id ?? body.payload?.order?.entity?.id;
        if (!providerOrderId || !payment?.id)
          return 'ignored: no order or payment id';
        if (payment.status !== undefined && payment.status !== 'captured')
          return `ignored: payment is ${payment.status}`;

        const order = await this.orders.findByProviderOrderId(providerOrderId);
        if (!order) {
          this.logger.warn(
            `Razorpay "${event}" for unknown order ${providerOrderId}`,
          );
          return 'ignored: unknown order';
        }
        if (order.provider !== 'razorpay') {
          this.logger.error(
            `Razorpay "${event}" for order ${order.id} of provider ${order.provider}`,
          );
          return 'ignored: not a Razorpay order';
        }
        // The amount is fixed when the Razorpay order is created, but never grant a
        // licence unless exactly the order's amount, in rupees, was captured. Money that
        // was captured but does not match is refunded, not kept.
        if (typeof payment.amount !== 'number') {
          this.logger.error(
            `Payment ${payment.id} for order ${order.id} has no amount; not granting`,
          );
          return 'ignored: no amount';
        }
        if (payment.amount !== order.amount || payment.currency !== 'INR') {
          await this.orders.refundStrayPayment(
            order,
            { id: payment.id, amount: payment.amount },
            `Captured ${payment.amount} ${payment.currency ?? '?'} for an order of ${order.amount} INR`,
          );
          return 'refund_pending: amount mismatch';
        }
        const paidAt =
          typeof payment.created_at === 'number'
            ? new Date(payment.created_at * 1000)
            : new Date();
        const result = await this.orders.markPaid(order.id, {
          id: payment.id,
          paidAt,
        });
        return result.outcome;
      }

      case 'payment.failed': {
        if (!payment?.order_id) return 'ignored: no order id';
        const order = await this.orders.findByProviderOrderId(payment.order_id);
        if (!order || order.provider !== 'razorpay')
          return 'ignored: unknown order';
        return (await this.orders.markFailed(order.id))
          ? 'failed'
          : 'unchanged';
      }

      case 'refund.processed': {
        const refund = body.payload?.refund?.entity;
        const paymentId = refund?.payment_id ?? payment?.id;
        if (!paymentId || !refund?.id)
          return 'ignored: no payment or refund id';
        // A refund we asked for (lost race, expired checkout, double payment)...
        if (await this.refunds.markProcessed(paymentId, refund.id))
          return 'refund_processed';
        // ...or one made outside Micky (the Razorpay dashboard): revoke the sale.
        const result = await this.orders.reverseSaleForRefund(
          paymentId,
          `Payment refunded at the gateway (${refund.id})`,
        );
        if (result === 'reversed' && refund.amount !== undefined) {
          const order = await this.orders.findByProviderPaymentId(paymentId);
          if (order && refund.amount < order.amount)
            this.logger.warn(
              `Partial refund ${refund.id} (${refund.amount} of ${order.amount} paise) treated as a full revocation`,
            );
        }
        return result === 'reversed'
          ? 'sale_reversed'
          : `ignored: ${result} payment`;
      }

      case 'refund.failed': {
        const refund = body.payload?.refund?.entity;
        const paymentId = refund?.payment_id ?? payment?.id;
        if (!paymentId) return 'ignored: no payment id';
        return (await this.refunds.markFailed(
          paymentId,
          'The payment gateway reported the refund as failed',
          refund?.id,
        ))
          ? 'refund_failed'
          : 'ignored: unknown refund';
      }

      case 'payment.dispute.created':
      case 'payment.dispute.action_required':
      case 'payment.dispute.under_review':
      case 'payment.dispute.lost': {
        const dispute = body.payload?.dispute?.entity;
        const paymentId = dispute?.payment_id ?? payment?.id;
        if (!paymentId) return 'ignored: no payment id';
        const stage = event.replace('payment.dispute.', '');
        const result = await this.orders.openDispute(
          paymentId,
          dispute?.id
            ? `Chargeback ${dispute.id} (${stage})`
            : `Chargeback (${stage})`,
        );
        if (event === 'payment.dispute.lost')
          this.logger.warn(
            `Dispute on payment ${paymentId} lost; the sale stays reversed`,
          );
        return result === 'reversed'
          ? 'disputed'
          : `ignored: ${result} payment`;
      }

      case 'payment.dispute.won': {
        const paymentId =
          body.payload?.dispute?.entity?.payment_id ?? payment?.id;
        if (!paymentId) return 'ignored: no payment id';
        const result = await this.orders.disputeWon(paymentId);
        return result === 'reinstated'
          ? 'dispute_won'
          : `ignored: ${result} payment`;
      }

      default:
        // payment.authorized, refund.created, payment.dispute.closed, ...: acknowledge them.
        return 'ignored';
    }
  }
}
