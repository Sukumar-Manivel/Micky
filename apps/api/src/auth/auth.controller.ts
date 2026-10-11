import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { type AuthUser, CurrentUser, Public } from '../common/auth.decorators.js';
import { AppConfig } from '../config/app-config.js';
import { LoginDto, RegisterDto } from './auth.dto.js';
import { type AuthResult, AuthService } from './auth.service.js';
import { LoginBackoffException } from './rate-limit/login-backoff.service.js';

export const REFRESH_COOKIE = 'ff_refresh';

/**
 * Access token: short-lived (15 min), returned in the JSON body, kept in memory by the web app.
 * Refresh token: long-lived (7 days), stored only in an httpOnly cookie that JavaScript
 * cannot read, so an XSS bug cannot steal it.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  // Per client IP, shared across API processes in Redis. The hourly cap also slows anyone
  // using the 409 "already exists" answer to test many emails (docs/REVIEW.md L1).
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 }, long: { limit: 30, ttl: 3_600_000 } })
  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.register(dto));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.login(dto));
    } catch (err) {
      if (err instanceof LoginBackoffException) res.setHeader('Retry-After', String(err.retryAfterSec));
      throw err;
    }
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(readCookie(req)));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(readCookie(req));
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return { user: await this.auth.me(user.id) };
  }

  private respond(res: Response, result: AuthResult) {
    // Note: the cookie expiry is the token's own expiry, which never passes the session's
    // absolute end (SESSION_MAX_DAYS after login).
    res.cookie(REFRESH_COOKIE, result.refreshToken, {
      ...this.cookieOptions(),
      expires: result.refreshExpiresAt,
    });
    return { accessToken: result.accessToken, user: result.user };
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/api/v1/auth',
      domain: this.config.cookieDomain,
    };
  }
}

function readCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE];
}
