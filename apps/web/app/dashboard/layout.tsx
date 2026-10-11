import { RequireRole } from '@/components/require-role';
import { UPLOADER_ONLY } from '@/lib/roles';

export default function DashboardLayout({ children }: LayoutProps<'/dashboard'>) {
  return (
    <RequireRole roles={UPLOADER_ONLY}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8">{children}</div>
    </RequireRole>
  );
}
