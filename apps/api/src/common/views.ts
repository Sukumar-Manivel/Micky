// Shared mappers from database rows to the API response shapes in docs/API.md.
// Keeping them in one place means the uploader dashboard, the admin queue and the
// marketplace always describe a media item the same way.
import type { media, verifications } from '../db/schema.js';
import { deliveryExt, readDeliveryInfo } from '../processing/delivery.js';
import type { UrlService } from './urls.service.js';

type MediaRow = typeof media.$inferSelect;
type VerificationRow = typeof verifications.$inferSelect;

export interface VerificationView {
  riskLevel: VerificationRow['riskLevel'];
  aiScore: number | null;
  aiModel: string | null;
  c2paStatus: string;
  c2paIssuer: string | null;
  duplicateOfId: string | null;
  signals: VerificationRow['signals'];
  metadata: Record<string, unknown>;
}

/** Full metadata (GPS, device, ...) is only shown to admins. */
export function toVerificationView(
  row: VerificationRow,
  opts: { includeMetadata: boolean },
): VerificationView {
  return {
    riskLevel: row.riskLevel,
    aiScore: row.aiScore,
    aiModel: row.aiModel,
    c2paStatus: row.c2paStatus,
    c2paIssuer: row.c2paIssuer,
    duplicateOfId: row.duplicateOfId,
    signals: row.signals,
    metadata: opts.includeMetadata ? row.metadata : {},
  };
}

export interface MediaOwnerView {
  id: string;
  type: MediaRow['type'];
  status: MediaRow['status'];
  title: string;
  description: string | null;
  category: MediaRow['category'];
  latitude: number;
  longitude: number;
  locationName: string | null;
  capturedAt: string;
  createdAt: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  priceNonExclusive: number;
  priceExclusive: number;
  exclusiveSold: boolean;
  thumbnailUrl: string | null;
  reviewNote: string | null;
  processingError: string | null;
  salesCount: number;
  earned: number;
  verification: VerificationView | null;
}

export function toMediaOwnerView(
  row: MediaRow,
  extra: {
    urls: UrlService;
    verification?: VerificationRow | null;
    salesCount?: number;
    earned?: number;
    includeMetadata?: boolean;
  },
): MediaOwnerView {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    description: row.description,
    category: row.category,
    latitude: row.latitude,
    longitude: row.longitude,
    locationName: row.locationName,
    capturedAt: row.capturedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    durationSec: row.durationSec,
    width: row.width,
    height: row.height,
    priceNonExclusive: row.priceNonExclusive,
    priceExclusive: row.priceExclusive,
    exclusiveSold: row.exclusiveSold,
    thumbnailUrl: extra.urls.thumbnailUrl(row),
    reviewNote: row.reviewNote,
    processingError: row.processingError,
    salesCount: extra.salesCount ?? 0,
    earned: extra.earned ?? 0,
    verification: extra.verification
      ? toVerificationView(extra.verification, { includeMetadata: extra.includeMetadata ?? false })
      : null,
  };
}

export interface MediaMarketView {
  id: string;
  type: MediaRow['type'];
  title: string;
  description: string | null;
  category: MediaRow['category'];
  latitude: number;
  longitude: number;
  locationName: string | null;
  capturedAt: string;
  publishedAt: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  incidentId: string | null;
  priceNonExclusive: number;
  priceExclusive: number;
  availability: { nonExclusive: boolean; exclusive: boolean };
  /**
   * The caller's own paid purchase, if any. `fileSha256` is the SHA-256 of the file the
   * buyer downloads (the delivery copy without identifying metadata, review H3), so the
   * newsroom can check its download; null while that copy is being prepared.
   */
  purchased: { orderId: string; licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE'; fileSha256: string | null } | null;
  verification: VerificationView;
  distanceKm?: number;
}

/**
 * Decimal places of a published coordinate. 3 places = about 110 m north–south
 * (less east–west away from the equator): enough to find the street, not the balcony.
 * The uploader's "use my location" button fills in where the witness was standing,
 * so channels never see the exact point (review M8).
 */
export const PUBLIC_COORDINATE_DECIMALS = 3;

/** Rounds a coordinate for a marketplace view (see PUBLIC_COORDINATE_DECIMALS). */
export function publicCoordinate(value: number): number {
  const factor = 10 ** PUBLIC_COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Marketplace view. Never includes the uploader's identity.
 * `paidOrderCount` is the number of PAID orders of this media (any buyer).
 * Coordinates are rounded (publicCoordinate) unless `exactLocation` is set, which
 * only admins get. Buyers get the rounded point too: there is no uploader opt-in
 * to share the exact one yet.
 */
export function toMediaMarketView(
  row: MediaRow,
  extra: {
    urls: UrlService;
    verification: VerificationRow | null;
    paidOrderCount: number;
    purchased: { orderId: string; licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE' } | null;
    includeMetadata?: boolean;
    exactLocation?: boolean;
    distanceKm?: number;
  },
): MediaMarketView {
  const exclusiveTaken = row.exclusiveSold;
  const exact = extra.exactLocation ?? false;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    category: row.category,
    latitude: exact ? row.latitude : publicCoordinate(row.latitude),
    longitude: exact ? row.longitude : publicCoordinate(row.longitude),
    locationName: row.locationName,
    capturedAt: row.capturedAt.toISOString(),
    publishedAt: (row.reviewedAt ?? row.createdAt).toISOString(),
    durationSec: row.durationSec,
    width: row.width,
    height: row.height,
    thumbnailUrl: extra.urls.thumbnailUrl(row),
    incidentId: row.incidentId,
    priceNonExclusive: row.priceNonExclusive,
    priceExclusive: row.priceExclusive,
    availability: {
      nonExclusive: row.status === 'APPROVED' && !exclusiveTaken && !extra.purchased,
      exclusive: row.status === 'APPROVED' && !exclusiveTaken && extra.paidOrderCount === 0,
    },
    purchased: extra.purchased
      ? { ...extra.purchased, fileSha256: readDeliveryInfo(extra.verification?.metadata)?.sha256 ?? null }
      : null,
    verification: extra.verification
      ? toVerificationView(extra.verification, { includeMetadata: extra.includeMetadata ?? false })
      : {
          riskLevel: 'MEDIUM',
          aiScore: null,
          aiModel: null,
          c2paStatus: 'unsupported',
          c2paIssuer: null,
          duplicateOfId: null,
          signals: [],
          metadata: {},
        },
    ...(extra.distanceKm !== undefined ? { distanceKm: Math.round(extra.distanceKm * 10) / 10 } : {}),
  };
}

/** Great-circle distance in km between two points (haversine formula). */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * The one file name a purchased download gets, used both in the API's JSON
 * (`GET /orders/:id/download` → fileName) and in the `Content-Disposition` header,
 * so the two can never disagree (review L8). The title reduced to letters, digits
 * and dashes (case kept), plus the extension of the file actually delivered
 * (decided by us from the stored type, never from the client's file name).
 */
export function downloadFileName(title: string, ext: string): string {
  const base =
    title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80)
      .replace(/^-|-$/g, '') || 'micky-media';
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? `${base}${ext}` : base;
}

/** `downloadFileName` for a media row: the delivery copy's extension (HEIC is delivered as .jpg). */
export function deliveryFileName(row: Pick<MediaRow, 'title' | 'originalKey' | 'mimeType'>): string {
  return downloadFileName(row.title, deliveryExt(row));
}
