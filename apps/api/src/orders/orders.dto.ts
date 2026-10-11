import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { PaginationQuery } from '../common/pagination.js';
import {
  LICENSE_TYPES,
  type LicenseType,
  orderStatusEnum,
} from '../db/schema.js';

export class CreateOrderDto {
  @IsUUID()
  mediaId: string;

  @IsIn(LICENSE_TYPES)
  licenseType: LicenseType;
}

/** What Razorpay Checkout hands back to the browser after a successful payment. */
export class VerifyPaymentDto {
  @IsString()
  @Matches(/^pay_[A-Za-z0-9]{1,40}$/, {
    message: 'razorpayPaymentId must look like pay_XXXXXXXX',
  })
  razorpayPaymentId: string;

  // HMAC-SHA256 as hex: exactly 64 hex characters.
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: 'razorpaySignature must be a 64-character hex string',
  })
  razorpaySignature: string;
}

export const ORDER_STATUSES = orderStatusEnum.enumValues;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export class ListOrdersQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;
}
