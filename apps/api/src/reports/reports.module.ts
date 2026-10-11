import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Public grievance / takedown reports. Admins handle them in AdminModule. */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
