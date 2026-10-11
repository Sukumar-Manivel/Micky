import type { Metadata } from 'next';
import { EarningsView } from './earnings-view';

export const metadata: Metadata = { title: 'Earnings' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function EarningsPage() {
  return <EarningsView />;
}
