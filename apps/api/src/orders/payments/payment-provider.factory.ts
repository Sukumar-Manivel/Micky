import type { Provider } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { MockProvider } from './mock.provider.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import { RazorpayProvider } from './razorpay.provider.js';

/**
 * Nest factory provider: picks the gateway from PAYMENTS_PROVIDER once, at startup.
 * Inject it with `@Inject(PAYMENT_PROVIDER) provider: PaymentProvider`.
 */
export const paymentProviderFactory: Provider = {
  provide: PAYMENT_PROVIDER,
  inject: [AppConfig],
  useFactory: (config: AppConfig): PaymentProvider => {
    if (config.paymentsProvider === 'razorpay') {
      // AppConfig already refused to start if any of these is missing.
      return new RazorpayProvider({
        keyId: config.razorpayKeyId!,
        keySecret: config.razorpayKeySecret!,
        webhookSecret: config.razorpayWebhookSecret!,
      });
    }
    return new MockProvider();
  },
};
