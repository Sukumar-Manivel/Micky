'use client';

// Leaflet touches `window` as soon as it is imported, so this file must never run on the server.
// It is only imported through `components/maps.tsx`, which uses next/dynamic with ssr: false.

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { CATEGORY_LABEL } from '@/lib/format';
import type { Category } from '@/lib/types';

export interface LatLng {
  lat: number;
  lng: number;
}

// Leaflet's default marker uses image files that bundlers don't copy. A CSS-styled divIcon
// avoids that and lets the pin use our theme colours.
const pinIcon = L.divIcon({ className: '', html: '<div class="map-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const dragIcon = L.divIcon({
  className: '',
  html: '<div class="map-pin" data-kind="drag"></div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** Keeps the map centred on `center` when it changes from outside (e.g. "Use my location"). */
function Recenter({ center, zoom }: { center: LatLng; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([center.lat, center.lng], zoom ?? map.getZoom());
  }, [map, center.lat, center.lng, zoom]);
  return null;
}

function ClickToMove({ onChange }: { onChange: (p: LatLng) => void }) {
  useMapEvents({ click: (e) => onChange({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

/** A map with one draggable pin. Tap the map or drag the pin to move it. */
export function LocationPicker({ value, onChange }: { value: LatLng; onChange: (p: LatLng) => void }) {
  const handlers = useMemo(
    () => ({
      dragend(e: L.LeafletEvent) {
        const p = (e.target as L.Marker).getLatLng();
        onChange({ lat: p.lat, lng: p.lng });
      },
    }),
    [onChange],
  );
  return (
    <MapContainer center={[value.lat, value.lng]} zoom={15} className="h-64 w-full rounded-lg" scrollWheelZoom={false}>
      <TileLayer attribution={OSM_ATTRIBUTION} url={OSM_TILES} />
      <Marker position={[value.lat, value.lng]} draggable icon={dragIcon} eventHandlers={handlers} keyboard>
        <Popup>Drag me to where it happened</Popup>
      </Marker>
      <ClickToMove onChange={onChange} />
      <Recenter center={value} />
    </MapContainer>
  );
}

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  title: string;
  category: Category;
  /** Where the popup's "Open" link goes; omit for a pin with no page (e.g. in admin review). */
  href?: string;
  detail?: string;
}

/** Fits the view around all points once they arrive. */
function FitBounds({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 13 });
  }, [map, points]);
  return null;
}

/** Incidents or media as pins; each popup links to its page. Default view: Tamil Nadu. */
export function PointsMap({ points, className = 'h-[60vh] min-h-80 w-full rounded-xl' }: { points: MapPoint[]; className?: string }) {
  return (
    <MapContainer center={[11.1, 78.6]} zoom={7} className={className}>
      <TileLayer attribution={OSM_ATTRIBUTION} url={OSM_TILES} />
      {points.map((p) => (
        <Marker key={p.id} position={[p.lat, p.lng]} icon={pinIcon} title={p.title}>
          <Popup>
            <strong>{p.title}</strong>
            <br />
            {CATEGORY_LABEL[p.category]}
            {p.detail ? ` · ${p.detail}` : ''}
            {p.href ? (
              <>
                <br />
                <Link href={p.href}>Open</Link>
              </>
            ) : null}
          </Popup>
        </Marker>
      ))}
      <FitBounds points={points} />
    </MapContainer>
  );
}
