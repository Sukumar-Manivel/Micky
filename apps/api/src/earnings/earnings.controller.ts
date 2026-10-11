import {
  Body,
  Controller,
  Get,
  Ip,
  Post,
  Put,
  Query,
  Headers,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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

  /** Needs the current password, so it is rate limited like login (password guessing). */
  @Put('payout-details')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  setPayoutDetails(
    @CurrentUser() user: AuthUser,
    @Body() dto: PayoutDetailsDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.earnings.setPayoutDetails(user, dto, { ip, userAgent });
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
