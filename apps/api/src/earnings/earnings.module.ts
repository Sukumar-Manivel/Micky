import { Module } from '@nestjs/common';
import { EarningsController } from './earnings.controller.js';
import { EarningsService } from './earnings.service.js';

/** Uploader balance, ledger, sales and payout requests. */
@Module({
  controllers: [EarningsController],
  providers: [EarningsService],
})
export class EarningsModule {}
