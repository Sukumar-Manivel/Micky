import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { AccessTokenPayload } from '../common/auth.guards.js';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { channelProfiles, refreshTokens, uploaderProfiles, users } from '../db/schema.js';
import type { LoginDto, RegisterDto } from './auth.dto.js';
import { loadUserView, type UserView } from './user-view.js';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: UserView;
}

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
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.db.query.users.findFirst({
      where: eq(users.email, dto.email),
      columns: { id: true },
    });
    if (existing) throw new ConflictException('An account with this email already exists');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // User and profile are created together, or not at all.
    const userId = await this.db.transaction(async (tx) => {
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
    });

    this.logger.log(`Registered ${dto.role} ${userId}`);
    return this.issueTokens(userId);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, dto.email) });
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException('Incorrect email or password');
    return this.issueTokens(user.id);
  }

  /**
   * Exchanges a refresh token for a new access token and a new refresh token (rotation).
   * If an already-rotated token is used again, it was probably stolen, so every
   * session of that user is revoked.
   */
  async refresh(rawToken: string | undefined): Promise<AuthResult> {
    if (!rawToken) throw new UnauthorizedException('No refresh token');
    const stored = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, hashToken(rawToken)),
    });
    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.revokedAt) {
      this.logger.warn(`Refresh token reuse detected for user ${stored.userId}; revoking all sessions`);
      await this.revokeAll(stored.userId);
      throw new UnauthorizedException('Session expired, please log in again');
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedException('Session expired, please log in again');

    const result = await this.issueTokens(stored.userId);
    const replacement = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, hashToken(result.refreshToken)),
      columns: { id: true },
    });
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedById: replacement?.id })
      .where(eq(refreshTokens.id, stored.id));
    return result;
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

  private async issueTokens(userId: string): Promise<AuthResult> {
    const user = await this.me(userId);
    const payload: AccessTokenPayload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.jwtAccessSecret,
      expiresIn: this.config.jwtAccessTtlSec,
    });

    const refreshToken = randomBytes(48).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000);
    await this.db
      .insert(refreshTokens)
      .values({ userId, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiresAt });

    return { accessToken, refreshToken, refreshExpiresAt, user };
  }
}

/** Refresh tokens are long random strings, so a fast SHA-256 is enough (no bcrypt needed). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
