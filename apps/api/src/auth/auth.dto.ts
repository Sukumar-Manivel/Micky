import { Transform } from 'class-transformer';
import {
  isEmail,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

/**
 * The one definition of a valid account email, used by the DTOs below AND by the admin seed
 * script, so the seed can never create an admin that the login form then rejects.
 * class-validator's isEmail with its defaults (e.g. a TLD made only of letters).
 */
export function isAccountEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && isEmail(value);
}

/** Lower-cases and trims, exactly as the DTOs do before validating. */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * bcrypt only uses the first 72 BYTES of a password and silently ignores the rest
 * (docs/REVIEW.md I3). Reject longer passwords at registration instead of pretending.
 * Bytes, not characters: "é" is 2 bytes in UTF-8, many Tamil letters are 3.
 */
export const BCRYPT_MAX_BYTES = 72;
function MaxBytes(max: number, options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'maxBytes',
      validator: {
        validate: (value: unknown) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
        defaultMessage: () => `Password must be at most ${max} bytes (about ${max} letters, fewer for non-Latin scripts)`,
      },
    },
    options,
  );
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class RegisterDto {
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxBytes(BCRYPT_MAX_BYTES)
  password: string;

  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name: string;

  /** Admin accounts cannot be self-registered; they are created by the seed script. */
  @IsIn(['UPLOADER', 'CHANNEL'])
  role: 'UPLOADER' | 'CHANNEL';

  /** Required for news channels: the organisation's name. */
  @ValidateIf((o: RegisterDto) => o.role === 'CHANNEL')
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  organization?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: 'Website must be a full URL, e.g. https://example.com' })
  @MaxLength(300)
  website?: string;
}

export class LoginDto {
  @Transform(lower)
  @IsEmail()
  email: string;

  // Not capped at 72 bytes here: accounts created before the cap must still be able to log in
  // (bcrypt compares only the first 72 bytes either way).
  @IsString()
  @MaxLength(128)
  password: string;
}
