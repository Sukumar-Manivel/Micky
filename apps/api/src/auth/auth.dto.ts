import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class RegisterDto {
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
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

  @IsString()
  @MaxLength(128)
  password: string;
}
