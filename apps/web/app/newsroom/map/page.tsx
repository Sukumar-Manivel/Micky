import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/require-role';
import { IncidentMap } from './incident-map';

export const metadata: Metadata = { title: 'Incident map' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function MapPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IncidentMap />
    </Suspense>
  );
}
