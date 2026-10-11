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
import {
  ApprovedChannel,
  type AuthUser,
  CurrentUser,
  Roles,
} from '../common/auth.decorators.js';
import {
  CreateOrderDto,
  ListOrdersQuery,
  VerifyPaymentDto,
} from './orders.dto.js';
import { OrdersService } from './orders.service.js';

/**
 * Licence purchases by news channels (docs/API.md, "Orders and payments").
 * Buyer-only routes look the order up by (id, buyerId), so other people's orders are 404.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @Roles('CHANNEL')
  @ApprovedChannel()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.orders.create(user, dto);
  }

  @Post(':id/verify')
  @Roles('CHANNEL')
  @HttpCode(200)
  verify(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.orders.verify(user, id, dto);
  }

  @Post(':id/mock-pay')
  @Roles('CHANNEL')
  @HttpCode(200)
  mockPay(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.mockPay(user, id);
  }

  @Get()
  @Roles('CHANNEL')
  list(@CurrentUser() user: AuthUser, @Query() query: ListOrdersQuery) {
    return this.orders.list(user, query);
  }

  @Get(':id')
  @Roles('CHANNEL', 'ADMIN')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user, id);
  }

  @Get(':id/download')
  @Roles('CHANNEL')
  download(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.download(user, id);
  }
}
