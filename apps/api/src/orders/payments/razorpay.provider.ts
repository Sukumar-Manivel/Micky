import { Logger } from '@nestjs/common';
import Razorpay from 'razorpay';
import {
  type CreateProviderOrderInput,
  hmacSha256Matches,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderPaymentStatus,
  type ProviderRefund,
  type RefundInput,
} from './payment-provider.js';

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

/**
 * Razorpay Orders API + Standard Checkout.
 *
 * Flow: we create a Razorpay order on the server (the amount is fixed there, so the
 * browser cannot change the price), the browser opens Razorpay Checkout for that
 * order, and Razorpay returns { razorpay_payment_id, razorpay_signature } which we
 * verify here. Razorpay also sends a webhook, which we verify with a separate secret.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  private readonly logger = new Logger(RazorpayProvider.name);
  private readonly client: Razorpay;

  constructor(private readonly credentials: RazorpayCredentials) {
    this.client = new Razorpay({
      key_id: credentials.keyId,
      key_secret: credentials.keySecret,
    });
  }

  /** Public key id, sent to the browser so Checkout knows which account to use. */
  get keyId(): string {
    return this.credentials.keyId;
  }

  async createOrder(
    input: CreateProviderOrderInput,
  ): Promise<{ providerOrderId: string }> {
    try {
      const order = await this.client.orders.create({
        amount: input.amountPaise,
        currency: 'INR',
        receipt: input.receipt,
        notes: input.notes,
        // Capture automatically when the buyer authorises the payment. Without this the
        // payment stays "authorized" and Razorpay refunds it after a few days, while we
        // would already have granted the licence (review M5). The account's dashboard
        // setting is not relied on.
        payment_capture: true,
      });
      return { providerOrderId: order.id };
    } catch (err) {
      // The SDK rejects with a plain object ({ statusCode, error: { description } }), not an Error.
      this.logger.error(`Razorpay orders.create failed: ${describe(err)}`);
      throw new Error('Could not create the payment order with Razorpay');
    }
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment> {
    try {
      const p = (await this.client.payments.fetch(paymentId)) as unknown as {
        id: string;
        order_id?: string | null;
        status: ProviderPaymentStatus;
        amount: number | string;
        currency: string;
        created_at: number;
      };
      return {
        id: p.id,
        orderId: p.order_id ?? null,
        status: p.status,
        amount: Number(p.amount),
        currency: p.currency,
        createdAt: new Date(p.created_at * 1000),
      };
    } catch (err) {
      this.logger.error(
        `Razorpay payments.fetch(${paymentId}) failed: ${describe(err)}`,
      );
      throw new Error('Could not read the payment from Razorpay');
    }
  }

  /**
   * Full refund through the Refunds API. Idempotent: first look for a refund of this
   * payment that we created earlier (same receipt), or any refund that is not failed and
   * already covers the amount; only if there is none, create one.
   */
  async refund(input: RefundInput): Promise<ProviderRefund> {
    try {
      const existing = await this.client.payments.fetchMultipleRefund(
        input.paymentId,
        {
          count: 100,
        },
      );
      const usable = existing.items.filter((r) => r.status !== 'failed');
      const mine =
        usable.find((r) => r.receipt === input.receipt) ??
        usable.find((r) => Number(r.amount) >= input.amountPaise);
      if (mine) return { refundId: mine.id, status: mine.status };

      const created = await this.client.payments.refund(input.paymentId, {
        amount: input.amountPaise,
        speed: 'normal',
        receipt: input.receipt,
        notes: input.notes,
      });
      return { refundId: created.id, status: created.status };
    } catch (err) {
      // Network errors and 5xx are retried by the refund job; the message is stored for admins.
      this.logger.error(
        `Razorpay refund of ${input.paymentId} failed: ${describe(err)}`,
      );
      throw new Error(`Razorpay refund failed: ${describe(err)}`);
    }
  }

  /** Razorpay docs: HMAC_SHA256(order_id + "|" + payment_id, key_secret) == razorpay_signature. */
  verifyPaymentSignature(
    providerOrderId: string,
    paymentId: string,
    signature: string,
  ): boolean {
    return hmacSha256Matches(
      this.credentials.keySecret,
      `${providerOrderId}|${paymentId}`,
      signature,
    );
  }

  /** Razorpay docs: HMAC_SHA256(raw request body, webhook_secret) == X-Razorpay-Signature. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return hmacSha256Matches(
      this.credentials.webhookSecret,
      rawBody,
      signature,
    );
  }
}

/** The SDK rejects with a plain object ({ statusCode, error: { description } }), not an Error. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  const e = err as
    { statusCode?: number; error?: { description?: string } } | undefined;
  if (e?.error?.description)
    return `${e.statusCode ?? ''} ${e.error.description}`.trim();
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
