import type { Metadata } from 'next';
import { PayoutQueue } from './payout-queue';

export const metadata: Metadata = { title: 'Payouts' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function AdminRoutePage() {
  return <PayoutQueue />;
}
