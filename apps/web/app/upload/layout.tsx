import { RequireRole } from '@/components/require-role';
import { UPLOADER_ONLY } from '@/lib/roles';

// Everything below this layout waits for the browser to restore the session (an in-memory
// access token, see lib/session.ts), so the server can only render the loading skeleton.
// Tell Next.js not to validate these segments for instant navigation; they are client-gated
// on purpose. (Next.js docs: route segment config `instant`.)
export const instant = false;

export default function UploadLayout({ children }: LayoutProps<'/upload'>) {
  return <RequireRole roles={UPLOADER_ONLY}>{children}</RequireRole>;
}
