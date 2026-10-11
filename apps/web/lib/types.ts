// Types that mirror docs/API.md exactly. If the contract changes, change it there first,
// then here. Money is always integer paise (₹1 = 100 paise); dates are ISO strings in UTC.

export type Role = 'UPLOADER' | 'CHANNEL' | 'ADMIN';
export type Category =
  | 'FIRE'
  | 'ACCIDENT'
  | 'FLOOD'
  | 'WEATHER'
  | 'PROTEST'
  | 'CRIME'
  | 'INFRASTRUCTURE'
  | 'OTHER';
export type MediaType = 'VIDEO' | 'PHOTO';
export type MediaStatus = 'PROCESSING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'FAILED' | 'REMOVED';
export type LicenseType = 'NON_EXCLUSIVE' | 'EXCLUSIVE';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type ChannelStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export const CATEGORIES: readonly Category[] = [
  'FIRE',
  'ACCIDENT',
  'FLOOD',
  'WEATHER',
  'PROTEST',
  'CRIME',
  'INFRASTRUCTURE',
  'OTHER',
];

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  channel: { organization: string; website: string | null; status: ChannelStatus } | null;
  uploader: { upiId: string | null } | null;
}

export interface AuthResponse {
  accessToken: string;
  user: UserView;
}

export interface Signal {
  code: string;
  level: 'info' | 'warning' | 'danger' | 'positive';
  message: string;
}

export type C2paStatus = 'valid' | 'invalid' | 'absent' | 'error' | 'unsupported';

export interface VerificationView {
  riskLevel: RiskLevel;
  aiScore: number | null;
  aiModel: string | null;
  c2paStatus: C2paStatus;
  c2paIssuer: string | null;
  duplicateOfId: string | null;
  signals: Signal[];
  metadata: Record<string, unknown>;
}

export interface MediaOwnerView {
  id: string;
  type: MediaType;
  status: MediaStatus;
  title: string;
  description: string | null;
  category: Category;
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

export interface MediaMarketView {
  id: string;
  type: MediaType;
  title: string;
  description: string | null;
  category: Category;
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
  purchased: { orderId: string; licenseType: LicenseType } | null;
  verification: VerificationView;
  distanceKm?: number;
}

export interface IncidentView {
  id: string;
  title: string;
  category: Category;
  latitude: number;
  longitude: number;
  locationName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  mediaCount: number;
  uploaderCount: number;
  trendScore: number;
  thumbnailUrl: string | null;
}

export type IncidentDetail = IncidentView & { media: MediaMarketView[] };

export type PreviewSession =
  | { kind: 'hls'; playlistUrl: string; expiresAt: string; watermarkText: string }
  | { kind: 'image'; imageUrl: string; expiresAt: string; watermarkText: string };

export type OrderStatus = 'CREATED' | 'PAID' | 'FAILED';

export interface OrderView {
  id: string;
  status: OrderStatus;
  licenseType: LicenseType;
  amount: number;
  currency: 'INR';
  createdAt: string;
  paidAt: string | null;
  downloadCount: number;
  media: { id: string; title: string; type: MediaType; thumbnailUrl: string | null };
}

export interface CheckoutView {
  orderId: string;
  amount: number;
  currency: 'INR';
  provider: 'razorpay' | 'mock';
  razorpay?: { keyId: string; orderId: string };
  description: string;
}

export interface DownloadLink {
  url: string;
  expiresAt: string;
  fileName: string;
}

export type LedgerEntryType = 'SALE_CREDIT' | 'PAYOUT_DEBIT' | 'PAYOUT_REVERSAL' | 'ADJUSTMENT';

export interface LedgerEntryView {
  id: string;
  type: LedgerEntryType;
  amount: number;
  note: string | null;
  createdAt: string;
  mediaTitle: string | null;
}

export type PayoutStatus = 'REQUESTED' | 'PAID' | 'REJECTED';

export interface PayoutView {
  id: string;
  amount: number;
  upiId: string;
  status: PayoutStatus;
  reference: string | null;
  note: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface EarningsSummary {
  balance: number;
  totalEarned: number;
  totalPaidOut: number;
  pendingPayouts: number;
  salesCount: number;
  recent: LedgerEntryView[];
}

export interface SaleView {
  orderId: string;
  mediaId: string;
  mediaTitle: string;
  licenseType: LicenseType;
  amount: number;
  uploaderShare: number;
  paidAt: string;
  buyerOrganization: string;
}

export interface AdminStats {
  users: { uploaders: number; channels: number; pendingChannels: number };
  media: { processing: number; inReview: number; approved: number; rejected: number };
  orders: { paid: number; revenue: number; platformFees: number };
  payouts: { requested: number; requestedAmount: number };
  reports: { open: number };
}

export interface UploaderRef {
  id: string;
  name: string;
  email: string;
}

export type ReviewItem = MediaOwnerView & { uploader: UploaderRef };
export type AdminPayout = PayoutView & { uploader: UploaderRef };

export type ReportReason = 'PRIVACY' | 'COPYRIGHT' | 'FAKE' | 'GRAPHIC' | 'OTHER';
export type ReportStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

/**
 * API.md references `Report` without spelling it out; this mirrors the `reports` table
 * (apps/api/src/db/schema.ts). Optional fields are tolerated if the backend omits them.
 */
export interface Report {
  id: string;
  mediaId: string | null;
  reporterEmail: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface UploadFields {
  title: string;
  description?: string;
  category: Category;
  latitude: number;
  longitude: number;
  locationName?: string;
  capturedAt: string;
  priceNonExclusive?: number;
  priceExclusive?: number;
}

/** Realtime events from the `/live` Socket.IO namespace. */
export interface MediaApprovedEvent {
  mediaId: string;
  incidentId: string | null;
  title: string;
  category: Category;
}
export interface IncidentUpdatedEvent {
  incidentId: string;
  trendScore: number;
  mediaCount: number;
}
