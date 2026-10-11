import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PaginationQuery } from '../common/pagination.js';
import {
  channelStatusEnum,
  payoutStatusEnum,
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

// ---- Bodies ----

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
