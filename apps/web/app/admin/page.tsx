import type { Metadata } from 'next';
import { AdminOverview } from './overview';

export const metadata: Metadata = { title: 'Admin overview' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function AdminRoutePage() {
  return <AdminOverview />;
}
