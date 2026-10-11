import type { Metadata } from 'next';
import { ReviewQueue } from './review-queue';

export const metadata: Metadata = { title: 'Review queue' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function AdminRoutePage() {
  return <ReviewQueue />;
}
