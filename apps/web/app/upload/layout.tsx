import { RequireRole } from '@/components/require-role';
import { UPLOADER_ONLY } from '@/lib/roles';

export default function UploadLayout({ children }: LayoutProps<'/upload'>) {
  return <RequireRole roles={UPLOADER_ONLY}>{children}</RequireRole>;
}
