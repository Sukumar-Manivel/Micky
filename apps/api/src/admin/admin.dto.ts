import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  NotEquals,
  ValidateIf,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination.js';
import {
  channelStatusEnum,
  orderStatusEnum,
  payoutStatusEnum,
  refundStatusEnum,
  reportStatusEnum,
  riskLevelEnum,
  type RiskLevel,
} from '../db/schema.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// ---- Queries ----

export class ReviewQueueQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(riskLevelEnum.enumValues)
  risk?: RiskLevel;
}

export class ListChannelsQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(channelStatusEnum.enumValues)
  status?: (typeof channelStatusEnum.enumValues)[number];
}

export class ListPayoutsQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(payoutStatusEnum.enumValues)
  status?: (typeof payoutStatusEnum.enumValues)[number];
}

export class ListReportsQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(reportStatusEnum.enumValues)
  status?: (typeof reportStatusEnum.enumValues)[number];
}

export class ListRefundsQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(refundStatusEnum.enumValues)
  status?: (typeof refundStatusEnum.enumValues)[number];
}

export class ListOrdersAdminQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(orderStatusEnum.enumValues)
  status?: (typeof orderStatusEnum.enumValues)[number];
}

// ---- Bodies ----

/**
 * A manual correction of an uploader's balance. Exactly one of uploaderId / uploaderEmail.
 * The note is mandatory: every rupee in the ledger must be explainable later.
 */
export class LedgerAdjustmentDto {
  @ValidateIf((o: LedgerAdjustmentDto) => o.uploaderEmail === undefined)
  @IsUUID()
  uploaderId?: string;

  @ValidateIf((o: LedgerAdjustmentDto) => o.uploaderId === undefined)
  @Transform(trim)
  @IsEmail()
  uploaderEmail?: string;

  /** Paise; positive credits the uploader, negative debits them. Never zero. */
  @Type(() => Number)
  @IsInt({ message: 'amount must be a whole number of paise' })
  @NotEquals(0, { message: 'amount must not be zero' })
  @Min(-10_000_000)
  @Max(10_000_000) // ±₹1,00,000: larger corrections should not be one click
  amount: number;

  @Transform(trim)
  @IsString()
  @Length(3, 500)
  note: string;
}

/** Approving media: a note is optional. */
export class OptionalNoteDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  note?: string;
}

/** Rejecting or removing something always needs a reason the user can read. */
export class RequiredNoteDto {
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  note: string;
}

export class MarkPayoutPaidDto {
  /** UPI / bank transaction reference (UTR), so the payment can be traced. */
  @Transform(trim)
  @IsString()
  @Length(3, 100)
  reference: string;
}

export class ResolveReportDto {
  @Transform(trim)
  @IsString()
  @Length(3, 2000)
  resolution: string;

  /** Also take the reported media down. */
  @IsOptional()
  @IsBoolean()
  removeMedia?: boolean;
}

export class DismissReportDto {
  @Transform(trim)
  @IsString()
  @Length(3, 2000)
  resolution: string;
}
