import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Query parameters accepted by every paginated list endpoint. */
export class PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

/** Shape of every paginated response: { items, page, pageSize, total }. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function offsetOf(query: PaginationQuery): number {
  return (query.page - 1) * query.pageSize;
}

export function paginated<T>(items: T[], total: number, query: PaginationQuery): Paginated<T> {
  return { items, page: query.page, pageSize: query.pageSize, total };
}
