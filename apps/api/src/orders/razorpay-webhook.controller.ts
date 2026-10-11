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
import { Public } from '../common/auth.decorators.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { webhookEvents } from '../db/schema.js';
import { OrdersService } from './orders.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from './payments/payment-provider.js';

/** The parts of a Razorpay webhook body we use. Everything else is ignored. */
interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; amount?: number } };
    order?: { entity?: { id?: string } };
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
 *   several times. We record each event id in `webhook_events` (primary key), and
 *   markPaid is itself idempotent as a second line of defence.
 * - Answer quickly: only a small database transaction happens here.
 */
@Controller('payments/razorpay')
export class RazorpayWebhookController {
  private readonly logger = new Logger(RazorpayWebhookController.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly orders: OrdersService,
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

    if (eventId) {
      // Claim the event id. If the row already exists, this delivery is a retry.
      const claimed = await this.db
        .insert(webhookEvents)
        .values({ id: eventId, provider: 'razorpay', type: event })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      if (claimed.length === 0)
        return { received: true, status: 'already processed' };
    } else {
      // Razorpay always sends this header; without it we still process safely,
      // because markPaid/markFailed are idempotent on their own.
      this.logger.warn(
        `Razorpay webhook "${event}" arrived without x-razorpay-event-id`,
      );
    }

    try {
      const status = await this.process(event, body);
      return { received: true, status };
    } catch (err) {
      // Release the claim so Razorpay's retry can process the event, then answer 500.
      if (eventId)
        await this.db
          .delete(webhookEvents)
          .where(eq(webhookEvents.id, eventId));
      this.logger.error(
        `Failed to process Razorpay webhook "${event}" (${eventId}): ${String(err)}`,
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

        const order = await this.orders.findByProviderOrderId(providerOrderId);
        if (!order) {
          this.logger.warn(
            `Razorpay "${event}" for unknown order ${providerOrderId}`,
          );
          return 'ignored: unknown order';
        }
        // Defence in depth: the amount is fixed when the Razorpay order is created,
        // but never grant a licence for less money than the order is worth.
        if (payment.amount !== undefined && payment.amount < order.amount) {
          this.logger.error(
            `Payment ${payment.id} of ${payment.amount} paise is less than order ${order.id} (${order.amount}); not granting`,
          );
          return 'ignored: amount mismatch';
        }
        const result = await this.orders.markPaid(order.id, payment.id);
        return result.outcome;
      }

      case 'payment.failed': {
        if (!payment?.order_id) return 'ignored: no order id';
        const order = await this.orders.findByProviderOrderId(payment.order_id);
        if (!order) return 'ignored: unknown order';
        return (await this.orders.markFailed(order.id))
          ? 'failed'
          : 'unchanged';
      }

      default:
        // We subscribe to a few events only, but Razorpay may send others; acknowledge them.
        return 'ignored';
    }
  }
}
