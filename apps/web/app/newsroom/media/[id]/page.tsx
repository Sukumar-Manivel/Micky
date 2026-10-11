import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/require-role';
import { MarketMediaDetail } from './market-media-detail';

export const metadata: Metadata = { title: 'Footage' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function MarketMediaPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <MarketMediaDetail />
    </Suspense>
  );
}
