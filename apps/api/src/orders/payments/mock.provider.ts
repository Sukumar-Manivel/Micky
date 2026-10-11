import { randomUUID } from 'node:crypto';
import type {
  CreateProviderOrderInput,
  PaymentProvider,
  ProviderPayment,
  ProviderRefund,
  RefundInput,
} from './payment-provider.js';

/**
 * Fake gateway for development, demos and tests (never allowed in production;
 * AppConfig refuses to start with it there).
 *
 * Payments are completed with POST /orders/:id/mock-pay instead of a real checkout,
 * so there is no signature to check: both verify methods always return false.
 * That way nobody can "pay" a mock order through the Razorpay routes.
 *
 * Refunds succeed at once (status `processed`), so the whole refund flow (queue job,
 * order REFUNDED, admin screens) can be demoed and tested without a gateway. They are
 * idempotent per payment id, like the real ones.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  private readonly refunds = new Map<string, ProviderRefund>();

  async createOrder(
    _input: CreateProviderOrderInput,
  ): Promise<{ providerOrderId: string }> {
    return { providerOrderId: `mock_order_${randomUUID()}` };
  }

  verifyPaymentSignature(): boolean {
    return false;
  }

  verifyWebhookSignature(): boolean {
    return false;
  }

  fetchPayment(paymentId: string): Promise<ProviderPayment> {
    // Mock payments never go through /verify (the signature check above always fails).
    return Promise.reject(
      new Error(`The mock provider cannot fetch payment ${paymentId}`),
    );
  }

  async refund(input: RefundInput): Promise<ProviderRefund> {
    const existing = this.refunds.get(input.paymentId);
    if (existing) return existing;
    const created: ProviderRefund = {
      refundId: `mock_rfnd_${randomUUID()}`,
      status: 'processed',
    };
    this.refunds.set(input.paymentId, created);
    return created;
  }
}
