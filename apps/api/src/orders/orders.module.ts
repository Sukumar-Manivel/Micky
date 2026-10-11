import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { paymentProviderFactory } from './payments/payment-provider.factory.js';
import { RazorpayWebhookController } from './razorpay-webhook.controller.js';

/** Licence purchases: checkout, payment confirmation (verify, mock-pay, webhook) and downloads. */
@Module({
  controllers: [OrdersController, RazorpayWebhookController],
  providers: [OrdersService, paymentProviderFactory],
  exports: [OrdersService],
})
export class OrdersModule {}
