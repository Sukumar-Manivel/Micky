'use client';

import { useState } from 'react';
import { FeedFilterBar, useFeedFilters, type FeedFilters } from '@/components/feed-filters';
import { LiveIndicator } from '@/components/live-indicator';
import { IncidentRow, MediaCard } from '@/components/market-cards';
import { useToast } from '@/components/toast';
import { Alert, ButtonLink, EmptyState, PageHeader, Pager, Skeleton } from '@/components/ui';
import { marketApi } from '@/lib/api';
import { CATEGORY_LABEL } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { useLive } from '@/lib/use-live';
import { useNow } from '@/lib/use-now';

const PAGE_SIZE = 20;

function locationQuery(f: FeedFilters) {
  return f.lat !== undefined && f.lng !== undefined ? { lat: f.lat, lng: f.lng, radiusKm: f.radiusKm ?? 50 } : {};
}

export function LiveFeed() {
  const [filters, setFilters] = useFeedFilters();
  const [page, setPage] = useState(1);
  const toast = useToast();
  const now = useNow();
  const searching = Boolean(filters.q);
  const filterKey = JSON.stringify({ ...filters, page });

  // Incidents, ranked by trend. Search uses the media endpoint, which supports text search.
  const incidents = useApi(searching ? null : `incidents ${filterKey}`, () =>
    marketApi.incidents({
      sort: 'trending',
      category: filters.category,
      sinceHours: filters.sinceHours,
      ...locationQuery(filters),
      page,
      pageSize: PAGE_SIZE,
    }),
  );
  const results = useApi(searching ? `media ${filterKey}` : null, () =>
    marketApi.media({
      q: filters.q,
      category: filters.category,
      sinceHours: filters.sinceHours,
      ...locationQuery(filters),
      sort: filters.lat !== undefined ? 'nearest' : 'recent',
      page,
      pageSize: PAGE_SIZE,
    }),
  );

  const changeFilters = (next: Partial<FeedFilters>) => {
    setPage(1);
    setFilters(next);
  };

  const live = useLive(true, {
    onMediaApproved: (e) => {
      toast(`New ${CATEGORY_LABEL[e.category].toLowerCase()} footage: ${e.title}`, 'live');
      incidents.reload();
      results.reload();
    },
    onIncidentUpdated: () => incidents.reload(),
  });

  const active = searching ? results : incidents;

  return (
    <>
      <PageHeader
        title={searching ? `Results for “${filters.q}”` : 'Trending now'}
        actions={
          <>
            <LiveIndicator status={live} />
            <ButtonLink href="/newsroom/map" variant="secondary" size="sm">
              Map view
            </ButtonLink>
          </>
        }
      >
        {searching
          ? 'Approved footage matching your search.'
          : 'Incidents ranked by how many separate witnesses filmed them and how recent they are.'}
      </PageHeader>

      <FeedFilterBar filters={filters} onChange={changeFilters} />

      <div className="mt-6">
        {active.error && !active.data ? <Alert>{active.error}</Alert> : null}
        {active.loading ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : searching && results.data ? (
          results.data.items.length === 0 ? (
            <EmptyState title="No footage matches">Try a nearby area name, a wider time range, or another category.</EmptyState>
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                {results.data.items.map((m) => (
                  <li key={m.id}>
                    <MediaCard media={m} now={now} />
                  </li>
                ))}
              </ul>
              <Pager page={page} pageSize={PAGE_SIZE} total={results.data.total} onPage={setPage} />
            </>
          )
        ) : !searching && incidents.data ? (
          incidents.data.items.length === 0 ? (
            <EmptyState title="Quiet for now">
              No incidents match these filters. Widen the time range or remove the category, and keep this page open: new
              footage appears here as soon as it is approved.
            </EmptyState>
          ) : (
            <>
              <ol className="border-t border-line">
                {incidents.data.items.map((i, idx) => (
                  <li key={i.id}>
                    <IncidentRow incident={i} rank={(page - 1) * PAGE_SIZE + idx + 1} now={now} />
                  </li>
                ))}
              </ol>
              <Pager page={page} pageSize={PAGE_SIZE} total={incidents.data.total} onPage={setPage} />
            </>
          )
        ) : null}
      </div>
    </>
  );
}
