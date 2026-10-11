import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

/**
 * Back office: stats, media moderation, channel approval, payouts and reports.
 * IncidentsService and RealtimeService come from global modules.
 */
@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
