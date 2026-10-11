import { Logger } from '@nestjs/common';
import Razorpay from 'razorpay';
import {
  type CreateProviderOrderInput,
  hmacSha256Matches,
  type PaymentProvider,
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
      });
      return { providerOrderId: order.id };
    } catch (err) {
      // The SDK rejects with a plain object ({ statusCode, error: { description } }), not an Error.
      this.logger.error(
        `Razorpay orders.create failed: ${JSON.stringify(err)}`,
      );
      throw new Error('Could not create the payment order with Razorpay');
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
