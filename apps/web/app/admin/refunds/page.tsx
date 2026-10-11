import type { Metadata } from 'next';
import { RefundQueue } from './refund-queue';

export const metadata: Metadata = { title: 'Refunds and disputes' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function AdminRoutePage() {
  return <RefundQueue />;
}
