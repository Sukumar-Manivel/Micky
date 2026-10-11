import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/require-role';
import { OwnerMediaDetail } from './owner-media-detail';

export const metadata: Metadata = { title: 'Upload details' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

// The id in the URL is only known at request time. With Cache Components on, anything that
// reads it must sit inside <Suspense>, so the rest of the page can be prerendered as a shell.
export default function OwnerMediaPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OwnerMediaDetail />
    </Suspense>
  );
}
