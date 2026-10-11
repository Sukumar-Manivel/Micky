'use client';

// Filters for the newsroom feed and map. The values live in the URL (?category=FIRE&since=24…)
// so a filtered view can be bookmarked, shared with a colleague, and survives a reload.

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { CATEGORY_LABEL } from '@/lib/format';
import { getCurrentPosition } from '@/lib/geolocation';
import { CATEGORIES, type Category } from '@/lib/types';
import { Button, inputClass } from './ui';

export interface FeedFilters {
  category?: Category;
  sinceHours: number;
  q?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
}

const SINCE_OPTIONS = [
  { value: 3, label: 'Last 3 hours' },
  { value: 24, label: 'Last 24 hours' },
  { value: 72, label: 'Last 3 days' },
  { value: 168, label: 'Last 7 days' },
  { value: 720, label: 'Last 30 days' },
];
const RADIUS_OPTIONS = [5, 25, 50, 100, 250];

function num(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function useFeedFilters(): [FeedFilters, (next: Partial<FeedFilters>) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const cat = params.get('category');
  const filters: FeedFilters = {
    category: CATEGORIES.includes(cat as Category) ? (cat as Category) : undefined,
    sinceHours: num(params.get('since')) ?? 72,
    q: params.get('q') ?? undefined,
    lat: num(params.get('lat')),
    lng: num(params.get('lng')),
    radiusKm: num(params.get('radius')),
  };

  const update = (next: Partial<FeedFilters>) => {
    const merged = { ...filters, ...next };
    const sp = new URLSearchParams();
    if (merged.category) sp.set('category', merged.category);
    if (merged.sinceHours !== 72) sp.set('since', String(merged.sinceHours));
    if (merged.q) sp.set('q', merged.q);
    if (merged.lat !== undefined && merged.lng !== undefined) {
      sp.set('lat', merged.lat.toFixed(4));
      sp.set('lng', merged.lng.toFixed(4));
      sp.set('radius', String(merged.radiusKm ?? 50));
    }
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [filters, update];
}

export function FeedFilterBar({
  filters,
  onChange,
  showSearch = true,
}: {
  filters: FeedFilters;
  onChange: (next: Partial<FeedFilters>) => void;
  showSearch?: boolean;
}) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const near = filters.lat !== undefined && filters.lng !== undefined;

  async function nearMe() {
    setLocating(true);
    setGeoError(null);
    try {
      const p = await getCurrentPosition();
      onChange({ lat: p.lat, lng: p.lng, radiusKm: filters.radiusKm ?? 50 });
    } catch (err) {
      setGeoError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocating(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto]">
        {showSearch ? (
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              onChange({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() || undefined });
            }}
            className="flex gap-2 sm:col-span-2 lg:col-span-1"
          >
            <label htmlFor="feed-q" className="sr-only">
              Search footage
            </label>
            <input
              id="feed-q"
              name="q"
              type="search"
              defaultValue={filters.q}
              placeholder="Search place or headline"
              className={inputClass}
            />
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
        ) : null}
        <div>
          <label htmlFor="feed-category" className="sr-only">
            Category
          </label>
          <select
            id="feed-category"
            value={filters.category ?? ''}
            onChange={(e) => onChange({ category: (e.target.value || undefined) as Category | undefined })}
            className={inputClass}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="feed-since" className="sr-only">
            Time range
          </label>
          <select
            id="feed-since"
            value={filters.sinceHours}
            onChange={(e) => onChange({ sinceHours: Number(e.target.value) })}
            className={inputClass}
          >
            {SINCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {near ? (
          <div className="flex gap-2">
            <label htmlFor="feed-radius" className="sr-only">
              Distance
            </label>
            <select
              id="feed-radius"
              value={filters.radiusKm ?? 50}
              onChange={(e) => onChange({ radiusKm: Number(e.target.value) })}
              className={inputClass}
            >
              {RADIUS_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  Within {r} km
                </option>
              ))}
            </select>
            <Button variant="ghost" onClick={() => onChange({ lat: undefined, lng: undefined, radiusKm: undefined })} aria-label="Stop filtering by distance">
              ✕
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={nearMe} busy={locating}>
            Near me
          </Button>
        )}
      </div>
      {geoError ? <p className="text-sm font-semibold text-caution">{geoError}</p> : null}
    </div>
  );
}
