// Shared mappers from database rows to the API response shapes in docs/API.md.
// Keeping them in one place means the uploader dashboard, the admin queue and the
// marketplace always describe a media item the same way.
import type { media, verifications } from '../db/schema.js';
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
  purchased: { orderId: string; licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE' } | null;
  verification: VerificationView;
  distanceKm?: number;
}

/**
 * Marketplace view. Never includes the uploader's identity.
 * `paidOrderCount` is the number of PAID orders of this media (any buyer).
 */
export function toMediaMarketView(
  row: MediaRow,
  extra: {
    urls: UrlService;
    verification: VerificationRow | null;
    paidOrderCount: number;
    purchased: MediaMarketView['purchased'];
    includeMetadata?: boolean;
    distanceKm?: number;
  },
): MediaMarketView {
  const exclusiveTaken = row.exclusiveSold;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    category: row.category,
    latitude: row.latitude,
    longitude: row.longitude,
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
    purchased: extra.purchased,
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
