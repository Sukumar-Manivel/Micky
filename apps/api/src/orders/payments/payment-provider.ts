import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * What the orders module needs from a payment gateway. Two implementations:
 * - RazorpayProvider: real (test or live) Razorpay account.
 * - MockProvider: no keys, no network; lets the whole flow be demoed and tested.
 *
 * Keeping the gateway behind an interface means the order logic (licence rules,
 * ledger, idempotency) never depends on a specific vendor.
 */
export interface PaymentProvider {
  readonly name: 'razorpay' | 'mock';

  /** Creates an order at the gateway. The browser's checkout widget pays this order. */
  createOrder(
    input: CreateProviderOrderInput,
  ): Promise<{ providerOrderId: string }>;

  /**
   * Checks the signature the checkout widget returns after a successful payment.
   * `providerOrderId` must come from OUR database, never from the client,
   * otherwise a buyer could replay a signature from a cheaper order.
   */
  verifyPaymentSignature(
    providerOrderId: string,
    paymentId: string,
    signature: string,
  ): boolean;

  /** Checks a webhook's signature over the exact bytes that were received. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;

  /**
   * Reads a payment from the gateway. Used by /verify: the checkout signature proves the
   * payment was *authorised*, not that the money was *captured*, so the licence is only
   * granted once the gateway itself says `captured` for the right amount.
   */
  fetchPayment(paymentId: string): Promise<ProviderPayment>;

  /**
   * Refunds a captured payment in full (`amountPaise` = what was captured).
   * Must be idempotent: calling it again for the same payment and `receipt` returns the
   * refund created the first time instead of refunding twice (the job may be retried
   * after a crash between the gateway call and our database write).
   */
  refund(input: RefundInput): Promise<ProviderRefund>;
}

export type ProviderPaymentStatus =
  'created' | 'authorized' | 'captured' | 'refunded' | 'failed';

export interface ProviderPayment {
  id: string;
  /** The gateway order this payment belongs to. */
  orderId: string | null;
  status: ProviderPaymentStatus;
  /** Paise. */
  amount: number;
  currency: string;
  /** When the buyer paid (used to judge whether the checkout had expired). */
  createdAt: Date;
}

export interface RefundInput {
  paymentId: string;
  amountPaise: number;
  /** Our refunds.id: stored at the gateway so a retried job finds its own refund. */
  receipt: string;
  notes: Record<string, string>;
}

export interface ProviderRefund {
  refundId: string;
  /** `pending` refunds finish later and are reported by the `refund.processed` webhook. */
  status: 'pending' | 'processed' | 'failed';
}

export interface CreateProviderOrderInput {
  amountPaise: number;
  /** Our own reference (max 40 chars at Razorpay). We use our order id. */
  receipt: string;
  notes: Record<string, string>;
}

/** Nest injection token for the active PaymentProvider. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * Computes HMAC-SHA256(payload, secret) as hex and compares it with `signature`
 * in constant time. A normal `===` stops at the first different character, so an
 * attacker could measure response times to guess a valid signature byte by byte;
 * `timingSafeEqual` always compares every byte.
 */
export function hmacSha256Matches(
  secret: string,
  payload: string | Buffer,
  signature: string,
): boolean {
  const expected = Buffer.from(
    createHmac('sha256', secret).update(payload).digest('hex'),
    'utf8',
  );
  const actual = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws when lengths differ; a different length is simply "no match".
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
