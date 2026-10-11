// Query parameters of the marketplace routes. Query strings always arrive as
// text, so numbers are converted with @Type(() => Number) before validation.
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CATEGORIES, type Category } from '../db/schema.js';
import { PaginationQuery } from '../common/pagination.js';

export const MEDIA_SORTS = ['recent', 'trending', 'nearest'] as const;
export const INCIDENT_SORTS = ['trending', 'recent'] as const;
export const MEDIA_TYPES = ['VIDEO', 'PHOTO'] as const;

/** Default search radius when lat/lng are given without radiusKm. */
export const DEFAULT_RADIUS_KM = 50;
/** Default time window of the incidents list. */
export const DEFAULT_INCIDENT_HOURS = 72;

/** Fields shared by both lists: an optional point and radius. */
class GeoQuery extends PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(500)
  radiusKm?: number;

  @IsOptional()
  @IsIn(CATEGORIES)
  category?: Category;
}

export class MarketMediaQuery extends GeoQuery {
  @IsOptional()
  @IsIn(MEDIA_TYPES)
  type?: (typeof MEDIA_TYPES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  sinceHours?: number;

  @IsOptional()
  @IsIn(MEDIA_SORTS)
  sort: (typeof MEDIA_SORTS)[number] = 'recent';

  /** Free-text search in title, description and location name. */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(100)
  q?: string;
}

export class MarketIncidentsQuery extends GeoQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  sinceHours: number = DEFAULT_INCIDENT_HOURS;

  @IsOptional()
  @IsIn(INCIDENT_SORTS)
  sort: (typeof INCIDENT_SORTS)[number] = 'trending';
}
