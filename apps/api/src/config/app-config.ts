import { Global, Injectable, Module } from '@nestjs/common';

/**
 * Typed application configuration, read once from environment variables.
 * Inject `AppConfig` anywhere instead of reading `process.env` directly,
 * so every setting is validated at startup and documented in one place.
 */
@Injectable()
export class AppConfig {
  readonly nodeEnv = str('NODE_ENV', 'development');
  readonly isProduction = this.nodeEnv === 'production';
  readonly isTest = this.nodeEnv === 'test';
  readonly port = int('PORT', 4000);

  /** Public base URL of this API, used to build absolute links (stream, downloads). */
  readonly publicApiUrl = str('PUBLIC_API_URL', 'http://localhost:4000').replace(/\/$/, '');
  /** Base URL of the web app. */
  readonly webUrl = str('WEB_URL', 'http://localhost:3000').replace(/\/$/, '');
  /** Allowed browser origins for CORS (comma separated). */
  readonly corsOrigins = list('CORS_ORIGINS', this.webUrl);

  readonly databaseUrl = str(
    'DATABASE_URL',
    'postgresql://firstframe:firstframe@localhost:5432/firstframe',
  );
  readonly databasePoolSize = int('DATABASE_POOL_SIZE', 10);
  readonly redisUrl = str('REDIS_URL', 'redis://localhost:6379');

  // ---- Auth ----
  readonly jwtAccessSecret = secret('JWT_ACCESS_SECRET', this.isProduction);
  readonly jwtAccessTtlSec = int('JWT_ACCESS_TTL_SEC', 15 * 60);
  readonly refreshTtlDays = int('REFRESH_TTL_DAYS', 7);
  /** Send cookies only over HTTPS. Always true in production. */
  readonly cookieSecure = bool('COOKIE_SECURE', this.isProduction);
  /** Optional cookie domain, e.g. ".firstframe.in" so web and api subdomains share it. */
  readonly cookieDomain = optional('COOKIE_DOMAIN');

  /** HMAC secret for short-lived signed URLs (stream, thumbnails, downloads). */
  readonly signingSecret = secret('SIGNING_SECRET', this.isProduction);

  // ---- Storage ----
  readonly storageDriver = oneOf('STORAGE_DRIVER', ['local', 's3'] as const, 'local');
  readonly storageLocalDir = str('STORAGE_LOCAL_DIR', './storage');
  readonly s3Endpoint = optional('S3_ENDPOINT'); // e.g. https://<account>.r2.cloudflarestorage.com
  readonly s3Region = str('S3_REGION', 'auto');
  readonly s3Bucket = str('S3_BUCKET', 'firstframe');
  readonly s3AccessKeyId = optional('S3_ACCESS_KEY_ID');
  readonly s3SecretAccessKey = optional('S3_SECRET_ACCESS_KEY');
  readonly s3ForcePathStyle = bool('S3_FORCE_PATH_STYLE', true);

  // ---- Uploads ----
  readonly uploadTmpDir = str('UPLOAD_TMP_DIR', './tmp/uploads');
  readonly maxVideoBytes = int('MAX_VIDEO_BYTES', 500 * 1024 * 1024);
  readonly maxPhotoBytes = int('MAX_PHOTO_BYTES', 25 * 1024 * 1024);
  readonly maxVideoDurationSec = int('MAX_VIDEO_DURATION_SEC', 10 * 60);

  // ---- Processing / verification ----
  readonly verifierUrl = str('VERIFIER_URL', 'http://localhost:8000');
  /** Shared secret sent to the verifier service in the X-Internal-Token header. */
  readonly internalToken = secret('INTERNAL_TOKEN', this.isProduction);
  readonly previewMaxSeconds = int('PREVIEW_MAX_SECONDS', 30);
  readonly workerConcurrency = int('WORKER_CONCURRENCY', 1);

  // ---- Payments ----
  readonly paymentsProvider = oneOf('PAYMENTS_PROVIDER', ['mock', 'razorpay'] as const, 'mock');
  readonly razorpayKeyId = optional('RAZORPAY_KEY_ID');
  readonly razorpayKeySecret = optional('RAZORPAY_KEY_SECRET');
  readonly razorpayWebhookSecret = optional('RAZORPAY_WEBHOOK_SECRET');
  /** Percentage of each sale kept by the platform (the rest goes to the uploader). */
  readonly platformFeePercent = int('PLATFORM_FEE_PERCENT', 30);
  /** Smallest payout an uploader can request, in paise. */
  readonly minPayoutPaise = int('MIN_PAYOUT_PAISE', 100_00);

  constructor() {
    if (this.paymentsProvider === 'razorpay') {
      for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
        if (!process.env[key]) throw new Error(`${key} is required when PAYMENTS_PROVIDER=razorpay`);
      }
    }
    if (this.isProduction && this.paymentsProvider === 'mock') {
      throw new Error('PAYMENTS_PROVIDER=mock is not allowed in production');
    }
    if (this.storageDriver === 's3' && (!this.s3AccessKeyId || !this.s3SecretAccessKey)) {
      throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_DRIVER=s3');
    }
    if (this.platformFeePercent < 0 || this.platformFeePercent > 100) {
      throw new Error('PLATFORM_FEE_PERCENT must be between 0 and 100');
    }
  }
}

@Global()
@Module({ providers: [AppConfig], exports: [AppConfig] })
export class AppConfigModule {}

// ---------- helpers ----------

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function str(name: string, fallback: string): string {
  return optional(name) ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function list(name: string, fallback: string): string[] {
  return str(name, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf<const T extends readonly string[]>(name: string, allowed: T, fallback: T[number]): T[number] {
  const value = str(name, fallback);
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
  return value as T[number];
}

/** Secrets must be set in production; in development a fixed insecure value is used. */
function secret(name: string, required: boolean): string {
  const value = optional(name);
  if (value) {
    if (required && value.length < 32) throw new Error(`${name} must be at least 32 characters`);
    return value;
  }
  if (required) throw new Error(`${name} is required in production`);
  return `dev-insecure-${name.toLowerCase()}-change-me`;
}
