import { randomUUID } from 'node:crypto';
import type {
  CreateProviderOrderInput,
  PaymentProvider,
} from './payment-provider.js';

/**
 * Fake gateway for development, demos and tests (never allowed in production;
 * AppConfig refuses to start with it there).
 *
 * Payments are completed with POST /orders/:id/mock-pay instead of a real checkout,
 * so there is no signature to check: both verify methods always return false.
 * That way nobody can "pay" a mock order through the Razorpay routes.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;

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
}
