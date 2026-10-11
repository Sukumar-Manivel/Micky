// Geographic filtering helpers for "within N km of a point" queries.
//
// Two steps, so the database does as little work as possible:
// 1. A cheap bounding box (lat BETWEEN .. AND lng BETWEEN ..) throws away
//    rows that are obviously too far. It is a rectangle around the circle.
// 2. The exact great-circle distance (haversine) is computed only for rows
//    that survived the box, and rows outside the circle are dropped.
//
// Both run in SQL so pagination and the total count are exact.
import { and, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/** A column or an SQL expression (e.g. the rounded coordinate from `publicCoordinateSql`). */
type Coordinate = PgColumn | SQL<number>;

/**
 * SQL for a coordinate rounded like the API shows it to channels
 * (common/views.ts `publicCoordinate`). Distance filters and `distanceKm` are computed
 * from this, not from the exact point: otherwise a few radius queries from different
 * centres would triangulate the witness's exact position.
 */
export function publicCoordinateSql(column: PgColumn, decimals: number): SQL<number> {
  return sql<number>`round(${column}::numeric, ${sql.raw(String(Math.trunc(decimals)))})::float8`;
}

/** Mean Earth radius in km (the same value `distanceKm` in common/views.ts uses). */
const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = (Math.PI * EARTH_RADIUS_KM) / 180; // about 111.2 km

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  /** Undefined when the box touches a pole or crosses the ±180° meridian (then we skip the longitude part). */
  minLng?: number;
  maxLng?: number;
}

/** The smallest lat/lng rectangle that contains every point within `radiusKm` of (lat, lng). */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox {
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const minLat = Math.max(-90, lat - dLat);
  const maxLat = Math.min(90, lat + dLat);

  // Near a pole every longitude can be within the radius.
  if (minLat <= -90 || maxLat >= 90) return { minLat, maxLat };

  // Widest longitude offset of a circle on a sphere: asin(sin(r/R) / cos(lat)).
  const angular = radiusKm / EARTH_RADIUS_KM;
  const ratio = Math.sin(angular) / Math.cos((lat * Math.PI) / 180);
  if (ratio >= 1) return { minLat, maxLat };
  const dLng = (Math.asin(ratio) * 180) / Math.PI;
  const minLng = lng - dLng;
  const maxLng = lng + dLng;

  // Crossing the antimeridian would need two ranges; it is rare, so we let the
  // exact haversine check alone handle it.
  if (minLng < -180 || maxLng > 180) return { minLat, maxLat };
  return { minLat, maxLat, minLng, maxLng };
}

/** SQL expression: haversine distance in km from (lat, lng) to the row's columns. */
export function distanceSql(latCol: Coordinate, lngCol: Coordinate, lat: number, lng: number): SQL<number> {
  // least(1, ...) guards against floating-point values just above 1, which asin() rejects.
  return sql<number>`(${EARTH_RADIUS_KM} * 2 * asin(least(1, sqrt(
      power(sin(radians(${latCol} - ${lat}) / 2), 2)
      + cos(radians(${lat})) * cos(radians(${latCol}))
      * power(sin(radians(${lngCol} - ${lng}) / 2), 2)
    ))))`;
}

/**
 * WHERE condition for "within radiusKm of (lat, lng)": bounding box first,
 * then the exact distance. Returns the distance expression too, for sorting
 * and for returning `distanceKm` to the client.
 */
export function withinRadius(
  latCol: Coordinate,
  lngCol: Coordinate,
  lat: number,
  lng: number,
  radiusKm: number,
): { where: SQL; distance: SQL<number> } {
  const box = boundingBox(lat, lng, radiusKm);
  const distance = distanceSql(latCol, lngCol, lat, lng);
  const where = and(
    sql`${latCol} BETWEEN ${box.minLat} AND ${box.maxLat}`,
    box.minLng !== undefined && box.maxLng !== undefined
      ? sql`${lngCol} BETWEEN ${box.minLng} AND ${box.maxLng}`
      : undefined,
    sql`${distance} <= ${radiusKm}`,
  )!;
  return { where, distance };
}

/** Escapes LIKE/ILIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
