import type { Metadata } from 'next';
import { Purchases } from './purchases';

export const metadata: Metadata = { title: 'Purchases' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function PurchasesPage() {
  return <Purchases />;
}
