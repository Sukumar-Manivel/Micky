import { eq } from 'drizzle-orm';
import type { Database } from '../db/db.module.js';
import { users } from '../db/schema.js';

/** The user object returned by the API. Never includes the password hash. */
export interface UserView {
  id: string;
  email: string;
  name: string;
  role: 'UPLOADER' | 'CHANNEL' | 'ADMIN';
  createdAt: string;
  channel: { organization: string; website: string | null; status: 'PENDING' | 'APPROVED' | 'REJECTED' } | null;
  uploader: { upiId: string | null } | null;
}

/** Loads a user with their profile and converts it to the public shape. */
export async function loadUserView(db: Database, userId: string): Promise<UserView | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    with: { channel: true, uploader: true },
  });
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    channel: user.channel
      ? { organization: user.channel.organization, website: user.channel.website, status: user.channel.status }
      : null,
    uploader: user.uploader ? { upiId: user.uploader.upiId } : null,
  };
}
