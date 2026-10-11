import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/require-role';
import { LiveFeed } from './live-feed';

export const metadata: Metadata = { title: 'Live feed' };

export default function NewsroomPage() {
  // LiveFeed reads its filters from the URL, so it renders inside Suspense.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <LiveFeed />
    </Suspense>
  );
}
