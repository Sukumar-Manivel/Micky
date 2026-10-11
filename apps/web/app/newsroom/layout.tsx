import { RequireRole } from '@/components/require-role';
import { NEWSROOM_ROLES } from '@/lib/roles';

// Admins can open the marketplace too, to see exactly what newsrooms see.
export default function NewsroomLayout({ children }: LayoutProps<'/newsroom'>) {
  return (
    <RequireRole roles={NEWSROOM_ROLES}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8">{children}</div>
    </RequireRole>
  );
}
