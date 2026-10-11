'use client';

import { useMemo } from 'react';
import { FeedFilterBar, useFeedFilters } from '@/components/feed-filters';
import { LiveIndicator } from '@/components/live-indicator';
import { PointsMap, type MapPoint } from '@/components/maps';
import { useToast } from '@/components/toast';
import { Alert, ButtonLink, PageHeader } from '@/components/ui';
import { marketApi } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { useLive } from '@/lib/use-live';

export function IncidentMap() {
  const [filters, setFilters] = useFeedFilters();
  const toast = useToast();
  const near = filters.lat !== undefined && filters.lng !== undefined;
  const { data, error, loading, reload } = useApi(`map ${JSON.stringify(filters)}`, () =>
    marketApi.incidents({
      sort: 'trending',
      category: filters.category,
      sinceHours: filters.sinceHours,
      ...(near ? { lat: filters.lat, lng: filters.lng, radiusKm: filters.radiusKm ?? 50 } : {}),
      pageSize: 100,
    }),
  );

  const live = useLive(true, {
    onMediaApproved: (e) => {
      toast(`New footage: ${e.title}`, 'live');
      reload();
    },
    onIncidentUpdated: () => reload(),
  });

  // Memoised so the map only re-fits its bounds when the data actually changes.
  const points: MapPoint[] = useMemo(
    () =>
      (data?.items ?? []).map((i) => ({
        id: i.id,
        lat: i.latitude,
        lng: i.longitude,
        title: i.title,
        category: i.category,
        href: `/newsroom/incidents/${i.id}`,
        detail: `${i.mediaCount} ${i.mediaCount === 1 ? 'clip' : 'clips'}`,
      })),
    [data],
  );

  return (
    <>
      <PageHeader
        title="Incident map"
        actions={
          <>
            <LiveIndicator status={live} />
            <ButtonLink href="/newsroom" variant="secondary" size="sm">
              List view
            </ButtonLink>
          </>
        }
      >
        Every incident with approved footage. Tap a pin to open it.
      </PageHeader>
      <FeedFilterBar filters={filters} onChange={setFilters} showSearch={false} />
      <div className="mt-6">
        {error ? <Alert>{error}</Alert> : null}
        <PointsMap points={points} />
        <p className="mt-2 text-sm text-muted" role="status">
          {loading
            ? 'Loading incidents…'
            : data
              ? data.items.length === 0
                ? 'No incidents match these filters. Widen the time range or remove the category.'
                : `${data.items.length} ${data.items.length === 1 ? 'incident' : 'incidents'} shown.`
              : null}
        </p>
      </div>
    </>
  );
}
