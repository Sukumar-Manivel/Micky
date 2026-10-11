import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const REPORT_REASONS = [
  'PRIVACY',
  'COPYRIGHT',
  'FAKE',
  'GRAPHIC',
  'OTHER',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export class CreateReportDto {
  /** Optional: a grievance can also be general (e.g. about the platform or an account). */
  @IsOptional()
  @IsUUID()
  mediaId?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  reporterEmail: string;

  @IsIn(REPORT_REASONS)
  reason: ReportReason;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(2000)
  details?: string;
}
