import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

/**
 * Back office: stats, media moderation, channel approval, payouts, refunds and
 * disputes, ledger adjustments and reports.
 * IncidentsService and RealtimeService come from global modules.
 */
@Module({
  imports: [OrdersModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
