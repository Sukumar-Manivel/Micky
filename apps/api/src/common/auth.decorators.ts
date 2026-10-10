import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '../db/schema.js';

/** The authenticated user attached to each request by the JWT guard. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as public: no access token required. All other routes require one. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restricts a route (or a whole controller) to the given roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const APPROVED_CHANNEL_KEY = 'approvedChannel';
/**
 * Requires that a CHANNEL user's organisation has been approved by an admin.
 * Admins always pass. Use together with @Roles('CHANNEL', 'ADMIN').
 */
export const ApprovedChannel = () => SetMetadata(APPROVED_CHANNEL_KEY, true);

/** Injects the authenticated user into a controller method parameter. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
  return request.user;
});
