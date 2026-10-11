import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { channelProfiles, type Role } from '../db/schema.js';
import {
  APPROVED_CHANNEL_KEY,
  type AuthUser,
  IS_PUBLIC_KEY,
  ROLES_KEY,
} from './auth.decorators.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
}

/**
 * Global guard: every route needs a valid `Authorization: Bearer <access token>`
 * unless it is marked @Public().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing access token');

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7), {
        secret: this.config.jwtAccessSecret,
        algorithms: ['HS256'], // never let the token choose its own algorithm
      });
      request.user = { id: payload.sub, email: payload.email, role: payload.role };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

/** Global guard: enforces @Roles(...) and @ApprovedChannel() metadata. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectDb() private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    const needsApprovedChannel = this.reflector.getAllAndOverride<boolean>(APPROVED_CHANNEL_KEY, targets);
    if (!roles?.length && !needsApprovedChannel) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) return true; // public route; JwtAuthGuard already decided

    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenException('Your account type cannot use this feature');
    }

    if (needsApprovedChannel && user.role === 'CHANNEL') {
      const profile = await this.db.query.channelProfiles.findFirst({
        where: eq(channelProfiles.userId, user.id),
        columns: { status: true },
      });
      if (profile?.status !== 'APPROVED') {
        throw new ForbiddenException('Your news organisation has not been approved yet');
      }
    }
    return true;
  }
}
