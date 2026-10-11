'use client';

// Client-only wrappers around the Leaflet maps. `ssr: false` stops Next.js from importing
// Leaflet during server rendering (it needs `window`), and also keeps Leaflet's ~40 kB out of
// the bundle for pages that never show a map.

import dynamic from 'next/dynamic';
import { Skeleton } from './ui';

export type { LatLng, MapPoint } from './map/leaflet-maps';

export const LocationPicker = dynamic(() => import('./map/leaflet-maps').then((m) => m.LocationPicker), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});

export const PointsMap = dynamic(() => import('./map/leaflet-maps').then((m) => m.PointsMap), {
  ssr: false,
  loading: () => <Skeleton className="h-[60vh] min-h-80 w-full" />,
});

/**
 * How newsroom pages describe a point the API has already rounded to about 100 m
 * (3 decimals; docs/REVIEW.md M8). Never shows more digits than the API gave.
 */
export function approximatePlace(lat: number, lng: number): string {
  return `Near ${lat.toFixed(3)}, ${lng.toFixed(3)} (±100 m)`;
}
