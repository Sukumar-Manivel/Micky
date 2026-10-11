import type { Metadata } from 'next';
import { MyFootage } from './my-footage';

export const metadata: Metadata = { title: 'My footage' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function DashboardPage() {
  return <MyFootage />;
}
