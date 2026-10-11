import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../common/auth.decorators.js';
import {
  DismissReportDto,
  ListChannelsQuery,
  ListPayoutsQuery,
  ListReportsQuery,
  MarkPayoutPaidDto,
  OptionalNoteDto,
  RequiredNoteDto,
  ResolveReportDto,
  ReviewQueueQuery,
} from './admin.dto.js';
import { AdminService } from './admin.service.js';

/** Back office (docs/API.md, "Admin"). @Roles on the class protects every route. */
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  // ---- Media moderation ----

  @Get('review-queue')
  reviewQueue(@Query() query: ReviewQueueQuery) {
    return this.admin.reviewQueue(query);
  }

  @Post('media/:id/approve')
  @HttpCode(200)
  approveMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OptionalNoteDto,
  ) {
    return this.admin.approveMedia(id, dto.note);
  }

  @Post('media/:id/reject')
  @HttpCode(200)
  rejectMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequiredNoteDto,
  ) {
    return this.admin.rejectMedia(id, dto.note);
  }

  @Post('media/:id/remove')
  @HttpCode(200)
  removeMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequiredNoteDto,
  ) {
    return this.admin.removeMedia(id, dto.note);
  }

  // ---- News channels ----

  @Get('channels')
  listChannels(@Query() query: ListChannelsQuery) {
    return this.admin.listChannels(query);
  }

  @Post('channels/:userId/approve')
  @HttpCode(200)
  approveChannel(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.admin.approveChannel(userId);
  }

  @Post('channels/:userId/reject')
  @HttpCode(200)
  rejectChannel(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: RequiredNoteDto,
  ) {
    return this.admin.rejectChannel(userId, dto.note);
  }

  // ---- Payouts ----

  @Get('payouts')
  listPayouts(@Query() query: ListPayoutsQuery) {
    return this.admin.listPayouts(query);
  }

  @Post('payouts/:id/mark-paid')
  @HttpCode(200)
  markPayoutPaid(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkPayoutPaidDto,
  ) {
    return this.admin.markPayoutPaid(id, dto.reference);
  }

  @Post('payouts/:id/reject')
  @HttpCode(200)
  rejectPayout(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequiredNoteDto,
  ) {
    return this.admin.rejectPayout(id, dto.note);
  }

  // ---- Grievance reports ----

  @Get('reports')
  listReports(@Query() query: ListReportsQuery) {
    return this.admin.listReports(query);
  }

  @Post('reports/:id/resolve')
  @HttpCode(200)
  resolveReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReportDto,
  ) {
    return this.admin.resolveReport(id, dto);
  }

  @Post('reports/:id/dismiss')
  @HttpCode(200)
  dismissReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DismissReportDto,
  ) {
    return this.admin.dismissReport(id, dto.resolution);
  }
}
