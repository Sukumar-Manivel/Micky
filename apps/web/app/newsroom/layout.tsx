import { RequireRole } from '@/components/require-role';
import { NEWSROOM_ROLES } from '@/lib/roles';

// Admins can open the marketplace too, to see exactly what newsrooms see.
// Everything below this layout waits for the browser to restore the session (an in-memory
// access token, see lib/session.ts), so the server can only render the loading skeleton.
// Tell Next.js not to validate these segments for instant navigation; they are client-gated
// on purpose. (Next.js docs: route segment config `instant`.)
export const instant = false;

export default function NewsroomLayout({ children }: LayoutProps<'/newsroom'>) {
  return (
    <RequireRole roles={NEWSROOM_ROLES}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8">{children}</div>
    </RequireRole>
  );
}
