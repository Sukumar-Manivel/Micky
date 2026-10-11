import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import {
  type AuthUser,
  CurrentUser,
  Roles,
} from '../common/auth.decorators.js';
import { PaginationQuery } from '../common/pagination.js';
import { PayoutDetailsDto, RequestPayoutDto } from './earnings.dto.js';
import { EarningsService } from './earnings.service.js';

/** Uploader money: balance, ledger, sales and payouts (docs/API.md, "Uploader earnings"). */
@Controller('me')
@Roles('UPLOADER')
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  @Put('payout-details')
  setPayoutDetails(
    @CurrentUser() user: AuthUser,
    @Body() dto: PayoutDetailsDto,
  ) {
    return this.earnings.setPayoutDetails(user, dto.upiId);
  }

  @Get('earnings')
  summary(@CurrentUser() user: AuthUser) {
    return this.earnings.summary(user);
  }

  @Get('ledger')
  ledger(@CurrentUser() user: AuthUser, @Query() query: PaginationQuery) {
    return this.earnings.ledger(user, query);
  }

  @Get('sales')
  sales(@CurrentUser() user: AuthUser, @Query() query: PaginationQuery) {
    return this.earnings.sales(user, query);
  }

  @Post('payouts')
  requestPayout(@CurrentUser() user: AuthUser, @Body() dto: RequestPayoutDto) {
    return this.earnings.requestPayout(user, dto.amount);
  }

  @Get('payouts')
  payouts(@CurrentUser() user: AuthUser, @Query() query: PaginationQuery) {
    return this.earnings.payouts(user, query);
  }
}
