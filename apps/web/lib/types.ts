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

export type OrderStatus =
  | 'CREATED'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REFUND_FAILED'
  | 'DISPUTED';

export interface OrderView {
  id: string;
  status: OrderStatus;
  licenseType: LicenseType;
  amount: number;
  currency: 'INR';
  createdAt: string;
  /** Until when an unpaid checkout can be paid. */
  expiresAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  /** Why the order is not (or no longer) PAID. */
  statusReason: string | null;
  downloadCount: number;
  media: { id: string; title: string; type: MediaType; thumbnailUrl: string | null };
}

export interface CheckoutView {
  orderId: string;
  amount: number;
  currency: 'INR';
  provider: 'razorpay' | 'mock';
  /** Pay before this moment; later payments are refunded. */
  expiresAt: string;
  razorpay?: { keyId: string; orderId: string };
  description: string;
}

export interface DownloadLink {
  url: string;
  expiresAt: string;
  fileName: string;
}

export type LedgerEntryType =
  | 'SALE_CREDIT'
  | 'SALE_REVERSAL'
  | 'SALE_REINSTATEMENT'
  | 'PAYOUT_DEBIT'
  | 'PAYOUT_REVERSAL'
  | 'ADJUSTMENT';

export interface LedgerEntryView {
  id: string;
  type: LedgerEntryType;
  amount: number;
  note: string | null;
  createdAt: string;
  /** When the row counts towards the withdrawable balance (future while a sale is on hold). */
  availableAt: string;
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

export interface PayoutDetailsView {
  upiId: string | null;
  /** When the UPI ID was last changed from a previous one. */
  changedAt: string | null;
  /** Payouts are paused until then after a change (null = no pause). */
  payoutsAllowedFrom: string | null;
}

export interface EarningsSummary {
  /** Everything; may be negative after a refund or chargeback. */
  balance: number;
  /** What can be withdrawn now. */
  available: number;
  /** Sale credits still inside the hold period. */
  onHold: number;
  nextReleaseAt: string | null;
  holdDays: number;
  totalEarned: number;
  totalPaidOut: number;
  pendingPayouts: number;
  salesCount: number;
  payoutDetails: PayoutDetailsView;
  recent: LedgerEntryView[];
}

export interface SaleView {
  orderId: string;
  mediaId: string;
  mediaTitle: string;
  licenseType: LicenseType;
  /** REFUNDED / DISPUTED when the sale was reversed. */
  status: 'PAID' | 'REFUNDED' | 'DISPUTED';
  amount: number;
  uploaderShare: number;
  paidAt: string;
  buyerOrganization: string;
}

export interface AdminStats {
  users: { uploaders: number; channels: number; pendingChannels: number };
  media: { processing: number; inReview: number; approved: number; rejected: number };
  orders: { paid: number; revenue: number; platformFees: number; disputed: number };
  refunds: { pending: number; failed: number };
  payouts: { requested: number; requestedAmount: number };
  reports: { open: number };
}

export interface UploaderRef {
  id: string;
  name: string;
  email: string;
}

export type ReviewItem = MediaOwnerView & { uploader: UploaderRef };
export type AdminPayout = PayoutView & {
  uploader: UploaderRef;
  upiChangedAt: string | null;
  /** The UPI ID was changed within 7 days before the request: check before paying. */
  upiChangedRecently: boolean;
};

export type RefundStatus = 'PENDING' | 'PROCESSED' | 'FAILED';

export interface BuyerRef {
  id: string;
  email: string;
  organization: string | null;
}

export interface AdminRefund {
  id: string;
  status: RefundStatus;
  amount: number;
  reason: string;
  providerPaymentId: string;
  providerRefundId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  processedAt: string | null;
  order: { id: string; status: OrderStatus; licenseType: LicenseType };
  media: { id: string; title: string };
  buyer: BuyerRef;
}

export type AdminOrder = OrderView & { providerPaymentId: string | null; buyer: BuyerRef };

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
