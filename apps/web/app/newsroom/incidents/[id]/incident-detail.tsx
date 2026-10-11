'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { CategoryBadge } from '@/components/badges';
import { PointsMap, type MapPoint } from '@/components/maps';
import { MediaCard } from '@/components/market-cards';
import { PageSkeleton } from '@/components/require-role';
import { useToast } from '@/components/toast';
import { EmptyState, LoadFailed } from '@/components/ui';
import { marketApi } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { approximatePlace } from '@/components/maps';
import { useLive } from '@/lib/use-live';
import { useNow } from '@/lib/use-now';

export function IncidentDetailView() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const now = useNow();
  const { data, error, loading, reload } = useApi(`incident ${id}`, () => marketApi.incident(id));

  // Refresh when new footage for THIS incident is approved.
  useLive(true, {
    onMediaApproved: (e) => {
      if (e.incidentId === id) {
        toast(`New footage for this incident: ${e.title}`, 'live');
        reload();
      }
    },
    onIncidentUpdated: (e) => {
      if (e.incidentId === id) reload();
    },
  });

  const points: MapPoint[] = useMemo(
    () =>
      (data?.media ?? []).map((m) => ({
        id: m.id,
        lat: m.latitude,
        lng: m.longitude,
        title: m.title,
        category: m.category,
        href: `/newsroom/media/${m.id}`,
      })),
    [data],
  );

  if (loading) return <PageSkeleton />;
  if (error && !data)
    return <LoadFailed title="Incident not available" message={error} backHref="/newsroom" backLabel="Back to the live feed" />;
  if (!data) return null;

  return (
    <article className="flex flex-col gap-8">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/newsroom" className="font-semibold text-muted hover:text-ink">
          ← Live feed
        </Link>
      </nav>
      <header className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="flex flex-col gap-3">
          <CategoryBadge category={data.category} />
          <h1 className="font-display text-5xl font-extrabold">{data.title}</h1>
          <p className="text-muted">{data.locationName ?? approximatePlace(data.latitude, data.longitude)}</p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 sm:grid-cols-4">
            <div>
              <dt className="text-sm text-muted">First footage</dt>
              <dd className="font-semibold">{formatDateTime(data.firstSeenAt)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Latest</dt>
              <dd className="font-semibold">{timeAgo(data.lastSeenAt, now)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Clips</dt>
              <dd className="font-display tabular text-2xl font-bold">{data.mediaCount}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Witnesses</dt>
              <dd className="font-display tabular text-2xl font-bold">{data.uploaderCount}</dd>
            </div>
          </dl>
        </div>
        <PointsMap points={points} className="h-64 w-full rounded-xl lg:h-full" />
      </header>

      <section aria-labelledby="footage-h">
        <h2 id="footage-h" className="mb-3 text-xl font-bold">
          Footage
        </h2>
        {data.media.length === 0 ? (
          <EmptyState title="No footage available">Everything from this incident has been licensed exclusively or removed.</EmptyState>
        ) : (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {data.media.map((m) => (
              <li key={m.id}>
                <MediaCard media={m} now={now} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
