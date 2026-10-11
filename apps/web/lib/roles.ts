// Role lists for <RequireRole>, defined once so they are stable references between renders.
import type { Role } from './types';

export const UPLOADER_ONLY: readonly Role[] = ['UPLOADER'];
export const NEWSROOM_ROLES: readonly Role[] = ['CHANNEL', 'ADMIN'];
export const ADMIN_ONLY: readonly Role[] = ['ADMIN'];
