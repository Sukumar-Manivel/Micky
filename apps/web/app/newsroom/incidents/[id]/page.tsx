import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/require-role';
import { IncidentDetailView } from './incident-detail';

export const metadata: Metadata = { title: 'Incident' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function IncidentPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IncidentDetailView />
    </Suspense>
  );
}
