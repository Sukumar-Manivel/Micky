import { Transform, Type } from 'class-transformer';
import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

/**
 * UPI virtual payment address: "<handle>@<bank>", e.g. "priya.k-92@okaxis".
 * Handle: letters, digits, dot, dash, underscore. Bank: letters only.
 */
export const UPI_ID_PATTERN = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;

export class PayoutDetailsDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(3, 100)
  @Matches(UPI_ID_PATTERN, {
    message: 'Enter a valid UPI ID, e.g. yourname@okaxis',
  })
  upiId: string;
}

export class RequestPayoutDto {
  /** Paise. The minimum is checked in the service because it comes from configuration. */
  @Type(() => Number)
  @IsInt({ message: 'amount must be a whole number of paise' })
  @Min(1)
  @Max(1_000_000_000) // ₹1 crore: far above any real balance, stops absurd values early
  amount: number;
}
