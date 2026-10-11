import { Global, Injectable, Module } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

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
  /**
   * Which process this is. Production containers only receive the secrets their process needs
   * (docs/REVIEW.md L3), so required secrets depend on the role:
   * - api:    JWT_ACCESS_SECRET, SIGNING_SECRET (+ Razorpay keys)
   * - worker: INTERNAL_TOKEN (to call the verifier)
   */
  readonly appRole = oneOf('APP_ROLE', ['api', 'worker'] as const, 'api');
  /**
   * How many reverse proxies sit in front of the API and append to X-Forwarded-For.
   * 1 = Caddy only (production: the API domain is "DNS only" in Cloudflare, never proxied).
   * Wrong values let clients spoof their IP (too high) or put everyone behind one IP (too low),
   * which matters because rate limits are per client IP.
   */
  readonly trustProxyHops = intIn('TRUST_PROXY_HOPS', 1, 0, 5);

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
  readonly jwtAccessSecret = secret('JWT_ACCESS_SECRET', this.isProduction, this.appRole === 'api');
  readonly jwtAccessTtlSec = int('JWT_ACCESS_TTL_SEC', 15 * 60);
  /** Idle lifetime: a refresh token not used for this long expires. */
  readonly refreshTtlDays = intIn('REFRESH_TTL_DAYS', 7, 1, 90);
  /**
   * Absolute lifetime: a login session ends this many days after the password was typed,
   * however often it is refreshed. Rotation never extends a session past this.
   */
  readonly sessionMaxDays = intIn('SESSION_MAX_DAYS', 30, 1, 365);
  /** Failed logins for one email allowed before backoff starts (per account, shared in Redis). */
  readonly loginFreeAttempts = intIn('LOGIN_FREE_ATTEMPTS', 5, 1, 100);
  /** First backoff after the free attempts; doubles with each further failure. */
  readonly loginBackoffBaseSec = intIn('LOGIN_BACKOFF_BASE_SEC', 30, 1, 3600);
  /** Longest backoff, so an attacker can never lock an account for long. */
  readonly loginBackoffMaxSec = intIn('LOGIN_BACKOFF_MAX_SEC', 15 * 60, 1, 24 * 3600);
  /** Send cookies only over HTTPS. Always true in production. */
  readonly cookieSecure = bool('COOKIE_SECURE', this.isProduction);
  /** Optional cookie domain, e.g. ".firstframe.in" so web and api subdomains share it. */
  readonly cookieDomain = optional('COOKIE_DOMAIN');

  /** HMAC secret for short-lived signed URLs (stream, thumbnails, downloads). */
  readonly signingSecret = secret('SIGNING_SECRET', this.isProduction, this.appRole === 'api');

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
  readonly internalToken = secret('INTERNAL_TOKEN', this.isProduction, this.appRole === 'worker');
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
  /**
   * Days a sale's credit is held before it can be paid out, so refunds and chargebacks that
   * arrive in that window can still be reversed (docs/REVIEW.md H2).
   */
  readonly earningsHoldDays = intIn('EARNINGS_HOLD_DAYS', 7, 0, 180);
  /** Hours payouts are blocked after an uploader changes their payout (UPI) details (M4). */
  readonly payoutCooldownHours = intIn('PAYOUT_COOLDOWN_HOURS', 24, 0, 24 * 30);

  constructor() {
    if (this.paymentsProvider === 'razorpay' && this.appRole === 'api') {
      for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
        if (!process.env[key]) throw new Error(`${key} is required when PAYMENTS_PROVIDER=razorpay`);
      }
    }
    if (this.isProduction && this.appRole === 'api' && this.paymentsProvider === 'mock') {
      throw new Error('PAYMENTS_PROVIDER=mock is not allowed in production');
    }
    if (this.storageDriver === 's3' && (!this.s3AccessKeyId || !this.s3SecretAccessKey)) {
      throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_DRIVER=s3');
    }
    if (this.platformFeePercent < 0 || this.platformFeePercent > 100) {
      throw new Error('PLATFORM_FEE_PERCENT must be between 0 and 100');
    }
    if (this.sessionMaxDays < this.refreshTtlDays) {
      throw new Error('SESSION_MAX_DAYS must be at least REFRESH_TTL_DAYS');
    }
    if (this.loginBackoffMaxSec < this.loginBackoffBaseSec) {
      throw new Error('LOGIN_BACKOFF_MAX_SEC must be at least LOGIN_BACKOFF_BASE_SEC');
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

/** An integer that must lie in [min, max]; a typo like 0 or 70000 fails at startup. */
function intIn(name: string, fallback: number, min: number, max: number): number {
  const value = int(name, fallback);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
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

/**
 * Secrets.
 * - Production, needed by this process: must be set and at least 32 characters.
 * - Production, not needed by this process (the container does not receive it): a random value
 *   nobody knows, so an unexpected use fails closed instead of using a guessable default.
 * - Development and tests: a fixed, insecure value when unset.
 */
function secret(name: string, production: boolean, neededHere: boolean): string {
  const value = optional(name);
  if (value) {
    if (production && value.length < 32) throw new Error(`${name} must be at least 32 characters`);
    return value;
  }
  if (production && neededHere) throw new Error(`${name} is required in production`);
  if (production) return randomBytes(32).toString('base64url');
  return `dev-insecure-${name.toLowerCase()}-change-me`;
}
