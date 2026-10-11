import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/require-role';
import { IncidentDetailView } from './incident-detail';

export const metadata: Metadata = { title: 'Incident' };

export default function IncidentPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IncidentDetailView />
    </Suspense>
  );
}
