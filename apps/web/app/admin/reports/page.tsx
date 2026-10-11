import type { Metadata } from 'next';
import { ReportQueue } from './report-queue';

export const metadata: Metadata = { title: 'Reports' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function AdminRoutePage() {
  return <ReportQueue />;
}
