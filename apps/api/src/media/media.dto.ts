import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE } from '../common/money.js';
import { PaginationQuery } from '../common/pagination.js';
import { CATEGORIES, type Category, type MediaStatus, mediaStatusEnum } from '../db/schema.js';

// Multipart fields always arrive as strings, so these transforms run before validation.
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** "" or missing → undefined (so optional fields stay optional); anything else → trimmed string. */
const optionalText = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};
/**
 * "12.5" → 12.5. Empty → undefined, so a missing required number fails @IsNumber
 * instead of silently becoming 0 (Number("") is 0!). Garbage → NaN, which fails too.
 */
const toNumber = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  return typeof value === 'number' ? value : Number(value);
};

/** Text fields of `POST /media` (multipart/form-data). The file itself arrives via multer. */
export class UploadMediaDto {
  @Transform(trim)
  @IsString()
  @Length(5, 120)
  title: string;

  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsIn(CATEGORIES)
  category: Category;

  @Transform(toNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude: number;

  @Transform(toNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude: number;

  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(200)
  locationName?: string;

  /** Range (not in the future, not older than 30 days) is checked in MediaService. */
  @IsISO8601({ strict: true })
  capturedAt: string;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(MIN_PRICE_PAISE)
  @Max(MAX_PRICE_PAISE)
  priceNonExclusive?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(MIN_PRICE_PAISE)
  @Max(MAX_PRICE_PAISE)
  priceExclusive?: number;

  @IsIn(['true'], { message: 'rightsConfirmed must be "true": confirm you shot this yourself and accept the uploader licence' })
  rightsConfirmed: 'true';
}

export class ListMyMediaQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(mediaStatusEnum.enumValues)
  status?: MediaStatus;
}

/** `PATCH /me/media/:id` (JSON). */
export class UpdateMediaDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(5, 120)
  title?: string;

  /** An empty string clears the description. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_PRICE_PAISE)
  @Max(MAX_PRICE_PAISE)
  priceNonExclusive?: number;

  @IsOptional()
  @IsInt()
  @Min(MIN_PRICE_PAISE)
  @Max(MAX_PRICE_PAISE)
  priceExclusive?: number;
}
