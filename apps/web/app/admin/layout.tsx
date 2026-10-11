import { AdminNav } from '@/components/admin-ui';
import { RequireRole } from '@/components/require-role';
import { ADMIN_ONLY } from '@/lib/roles';

// Everything under /admin is for ADMIN users only. The guard is for convenience (it redirects
// others to their own home page); the real check is @Roles('ADMIN') on every API route.
//
// Everything below this layout waits for the browser to restore the session (an in-memory
// access token, see lib/session.ts), so the server can only render the loading skeleton.
// Tell Next.js not to validate these segments for instant navigation; they are client-gated
// on purpose. (Next.js docs: route segment config `instant`.)
export const instant = false;

export default function AdminLayout({ children }: LayoutProps<'/admin'>) {
  return (
    <RequireRole roles={ADMIN_ONLY}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8">
        <AdminNav />
        {children}
      </div>
    </RequireRole>
  );
}
