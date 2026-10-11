import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { AccessTokenPayload } from '../common/auth.guards.js';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { channelProfiles, refreshTokens, uploaderProfiles, users } from '../db/schema.js';
import type { LoginDto, RegisterDto } from './auth.dto.js';
import { LoginBackoffService } from './rate-limit/login-backoff.service.js';
import { loadUserView, type UserView } from './user-view.js';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: UserView;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const DAY_MS = 24 * 60 * 60 * 1000;

const BCRYPT_ROUNDS = 12;
// A real hash, so login takes the same time whether or not the email exists
// (prevents finding registered emails by timing the response).
const DUMMY_HASH = bcrypt.hashSync('timing-safe-dummy-password', BCRYPT_ROUNDS);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly backoff: LoginBackoffService,
  ) {}

  /**
   * Registration answers 409 for an email that already has an account, so it does reveal
   * which emails are registered (docs/REVIEW.md L1). Hiding that needs a "check your inbox"
   * flow, and Micky has no email sending yet. Until it does, mass enumeration is slowed by
   * the per-IP limits on this route (10/min and 30/hour, shared in Redis). See
   * docs/learning/auth-and-security.md for the full trade-off.
   */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, dto.email),
      columns: { id: true },
    });
    if (existing) throw new ConflictException('An account with this email already exists');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // User and profile are created together, or not at all.
    const userId = await this.db
      .transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ email: dto.email, passwordHash, name: dto.name, role: dto.role })
          .returning({ id: users.id });
        if (dto.role === 'CHANNEL') {
          await tx
            .insert(channelProfiles)
            .values({ userId: user.id, organization: dto.organization!, website: dto.website });
        } else {
          await tx.insert(uploaderProfiles).values({ userId: user.id });
        }
        return user.id;
      })
      .catch((err: unknown) => {
        // Two requests for the same email can both pass the check above (a double submit);
        // the unique index on users.email stops the second one. Answer 409, not 500.
        if (isUniqueViolation(err)) throw new ConflictException('An account with this email already exists');
        throw err;
      });

    this.logger.log(`Registered ${dto.role} ${userId}`);
    return this.issueTokens(this.db, userId, new Date());
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    // Per-account backoff first: while an email is locked its password is not even checked.
    await this.backoff.assertAllowed(dto.email);
    const user = await this.db.query.users.findFirst({ where: eq(users.email, dto.email) });
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      // Counted for unknown emails too, so the 429 cannot be used to find registered ones.
      await this.backoff.recordFailure(dto.email);
      throw new UnauthorizedException('Incorrect email or password');
    }
    await this.backoff.recordSuccess(dto.email);
    return this.issueTokens(this.db, user.id, new Date());
  }

  /**
   * Exchanges a refresh token for a new access token and a new refresh token (rotation).
   * If an already-rotated token is used again, it was probably stolen, so every
   * session of that user is revoked.
   *
   * Race-free (docs/REVIEW.md M1): the old token is claimed with ONE conditional UPDATE
   * (`... WHERE revoked_at IS NULL AND expires_at > now() RETURNING`). Postgres locks the row,
   * so of two parallel requests with the same token exactly one gets the row back; the other
   * waits, re-checks `revoked_at IS NULL` after the first commits, gets zero rows and is
   * treated as reuse. The replacement is inserted in the same transaction, so a failure
   * never leaves the old token spent without a new one.
   *
   * Absolute lifetime: a token row's `created_at` is the start of its login session (the
   * replacement inherits it), and no token expires later than created_at + SESSION_MAX_DAYS.
   */
  async refresh(rawToken: string | undefined): Promise<AuthResult> {
    if (!rawToken) throw new UnauthorizedException('No refresh token');
    const tokenHash = hashToken(rawToken);

    const rotated = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, sql`now()`),
          ),
        )
        .returning({ id: refreshTokens.id, userId: refreshTokens.userId, createdAt: refreshTokens.createdAt });
      if (!claimed) return null;

      const result = await this.issueTokens(tx, claimed.userId, claimed.createdAt);
      await tx
        .update(refreshTokens)
        .set({ replacedById: result.refreshTokenId })
        .where(eq(refreshTokens.id, claimed.id));
      return result;
    });
    if (rotated) return rotated;

    // Not claimable: unknown, expired, or already used. Only the last one is suspicious.
    const stored = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
      columns: { userId: true, revokedAt: true },
    });
    if (!stored) throw new UnauthorizedException('Invalid refresh token');
    if (stored.revokedAt) {
      this.logger.warn(`Refresh token reuse detected for user ${stored.userId}; revoking all sessions`);
      await this.revokeAll(stored.userId);
    }
    throw new UnauthorizedException('Session expired, please log in again');
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.tokenHash, hashToken(rawToken)), isNull(refreshTokens.revokedAt)));
  }

  async me(userId: string): Promise<UserView> {
    const user = await loadUserView(this.db, userId);
    if (!user) throw new UnauthorizedException('Account no longer exists');
    return user;
  }

  private async revokeAll(userId: string) {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  /**
   * Signs an access token and stores a new refresh token.
   * `sessionStartedAt` is when the password was typed; it is stored as the token's created_at
   * and caps the token's expiry at sessionStartedAt + SESSION_MAX_DAYS.
   */
  private async issueTokens(
    executor: Database | Tx,
    userId: string,
    sessionStartedAt: Date,
  ): Promise<AuthResult & { refreshTokenId: string }> {
    const user = await this.me(userId);
    const payload: AccessTokenPayload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.jwtAccessSecret,
      expiresIn: this.config.jwtAccessTtlSec,
      algorithm: 'HS256',
    });

    const refreshToken = randomBytes(48).toString('base64url');
    const idleExpiry = Date.now() + this.config.refreshTtlDays * DAY_MS;
    const absoluteExpiry = sessionStartedAt.getTime() + this.config.sessionMaxDays * DAY_MS;
    const refreshExpiresAt = new Date(Math.min(idleExpiry, absoluteExpiry));
    if (refreshExpiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Session expired, please log in again');
    }
    const [row] = await executor
      .insert(refreshTokens)
      .values({ userId, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiresAt, createdAt: sessionStartedAt })
      .returning({ id: refreshTokens.id });

    return { accessToken, refreshToken, refreshExpiresAt, user, refreshTokenId: row.id };
  }
}

/** Postgres error 23505 (unique_violation); Drizzle wraps the driver error in `cause`. */
function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
  return code(err) === '23505' || code((err as { cause?: unknown } | null)?.cause) === '23505';
}

/** Refresh tokens are long random strings, so a fast SHA-256 is enough (no bcrypt needed). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
