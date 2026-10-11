import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/auth.decorators.js';
import { CreateReportDto } from './reports.dto.js';
import { ReportsService } from './reports.service.js';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Public, but rate limited (5 per minute per IP) to keep spam out of the admin queue. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  create(@Body() dto: CreateReportDto) {
    return this.reports.create(dto);
  }
}
