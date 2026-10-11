import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/require-role';
import { IncidentMap } from './incident-map';

export const metadata: Metadata = { title: 'Incident map' };

export default function MapPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IncidentMap />
    </Suspense>
  );
}
