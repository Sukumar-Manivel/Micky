import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CommerceProcessor } from './commerce.processor.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { paymentProviderFactory } from './payments/payment-provider.factory.js';
import { RazorpayWebhookController } from './razorpay-webhook.controller.js';
import { COMMERCE_QUEUE } from './refunds.constants.js';
import { RefundsService } from './refunds.service.js';

/**
 * Licence purchases: checkout, payment confirmation (verify, mock-pay, webhook), downloads,
 * and what happens to money afterwards: refunds (a BullMQ job), external refunds and
 * chargebacks (webhooks), and expiry of unpaid checkouts.
 */
@Module({
  imports: [BullModule.registerQueue({ name: COMMERCE_QUEUE })],
  controllers: [OrdersController, RazorpayWebhookController],
  providers: [
    OrdersService,
    RefundsService,
    CommerceProcessor,
    paymentProviderFactory,
  ],
  exports: [OrdersService, RefundsService],
})
export class OrdersModule {}
