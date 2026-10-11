// One typed function per endpoint in docs/API.md, all going through `request()`, which:
// 1. adds the Authorization header from the in-memory session,
// 2. on 401, refreshes the session once (single-flight, see session.ts) and retries once,
// 3. turns NestJS error bodies into an ApiError with a readable message.

import { apiBase } from './config';
import { createSessionStore } from './session';
import type {
  AdminOrder,
  AdminPayout,
  AdminRefund,
  AdminStats,
  AuthResponse,
  Category,
  CheckoutView,
  DownloadLink,
  EarningsSummary,
  IncidentDetail,
  IncidentView,
  LedgerEntryView,
  LicenseType,
  MediaMarketView,
  MediaOwnerView,
  MediaStatus,
  MediaType,
  OrderStatus,
  OrderView,
  Paginated,
  PayoutDetailsView,
  PayoutStatus,
  PayoutView,
  PreviewSession,
  Report,
  ReportReason,
  ReportStatus,
  RefundStatus,
  ReviewItem,
  RiskLevel,
  SaleView,
  ChannelStatus,
  UserView,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** NestJS sends `message` as a string or, for validation errors, an array of strings. */
export function errorMessageFromBody(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (Array.isArray(m)) return m.filter((x) => typeof x === 'string').join('. ');
    if (typeof m === 'string') return m;
  }
  if (status === 429) return 'Too many attempts. Please wait a minute and try again.';
  if (status >= 500) return 'The server had a problem. Please try again shortly.';
  return `Request failed (${status})`;
}

/** Friendly text for any thrown value, for showing in the UI. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  // fetch() rejects with a TypeError when the network is down or CORS blocks the request.
  if (err instanceof TypeError) return 'Could not reach FirstFrame. Check your internet connection.';
  // Errors we throw ourselves (e.g. Razorpay failures) carry a message written for people.
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function refreshCall(): Promise<AuthResponse | null> {
  const res = await fetch(`${apiBase()}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new ApiError(res.status, errorMessageFromBody(await readJson(res), res.status));
  return (await res.json()) as AuthResponse;
}

/** The app's single session. Exported so the auth context and the upload XHR share it. */
export const session = createSessionStore(refreshCall);

type Query = Record<string, string | number | boolean | undefined | null>;

export function toQuery(q?: Query): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Set false for public endpoints so a 401 does not trigger a refresh. */
  auth?: boolean;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, query, auth = true } = opts;

  const send = (token: string | null) =>
    fetch(`${apiBase()}${path}${toQuery(query)}`, {
      method,
      // Cookies are only needed for /auth/*, but including them everywhere is harmless:
      // the refresh cookie's path is /api/v1/auth, so the browser only sends it there.
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send(session.getToken());
  if (res.status === 401 && auth) {
    const fresh = await session.refresh();
    if (fresh) res = await send(fresh);
  }
  if (!res.ok) throw new ApiError(res.status, errorMessageFromBody(await readJson(res), res.status));
  if (res.status === 204) return undefined as T;
  return (await readJson(res)) as T;
}

const get = <T>(path: string, query?: Query) => request<T>('GET', path, { query });
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, { body });

type PageQuery = { page?: number; pageSize?: number };

// ---------- Auth ----------
export const authApi = {
  register: (body: {
    email: string;
    password: string;
    name: string;
    role: 'UPLOADER' | 'CHANNEL';
    organization?: string;
    website?: string;
  }) => request<AuthResponse>('POST', '/auth/register', { body, auth: false }),
  login: (body: { email: string; password: string }) =>
    request<AuthResponse>('POST', '/auth/login', { body, auth: false }),
  logout: () => request<void>('POST', '/auth/logout', { auth: false }),
  me: () => get<{ user: UserView }>('/auth/me'),
};

// ---------- Uploader: media ----------
export const myMediaApi = {
  list: (q: PageQuery & { status?: MediaStatus } = {}) => get<Paginated<MediaOwnerView>>('/me/media', q),
  get: (id: string) => get<MediaOwnerView>(`/me/media/${id}`),
  update: (
    id: string,
    body: { title?: string; description?: string; priceNonExclusive?: number; priceExclusive?: number },
  ) => request<MediaOwnerView>('PATCH', `/me/media/${id}`, { body }),
  remove: (id: string) => request<void>('DELETE', `/me/media/${id}`),
};

// ---------- Uploader: earnings ----------
export const earningsApi = {
  /** Changing where money goes needs the account password (and pauses payouts for 24 h). */
  setPayoutDetails: (upiId: string, currentPassword: string) =>
    request<{ user: UserView; payoutDetails: PayoutDetailsView }>('PUT', '/me/payout-details', {
      body: { upiId, currentPassword },
    }),
  summary: () => get<EarningsSummary>('/me/earnings'),
  ledger: (q: PageQuery = {}) => get<Paginated<LedgerEntryView>>('/me/ledger', q),
  sales: (q: PageQuery = {}) => get<Paginated<SaleView>>('/me/sales', q),
  requestPayout: (amount: number) => post<PayoutView>('/me/payouts', { amount }),
  payouts: (q: PageQuery = {}) => get<Paginated<PayoutView>>('/me/payouts', q),
};

// ---------- Marketplace ----------
export interface MarketMediaQuery extends PageQuery {
  category?: Category;
  type?: MediaType;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  sinceHours?: number;
  sort?: 'recent' | 'trending' | 'nearest';
  q?: string;
}
export interface IncidentQuery extends PageQuery {
  category?: Category;
  sinceHours?: number;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  sort?: 'trending' | 'recent';
}

export const marketApi = {
  media: (q: MarketMediaQuery = {}) => get<Paginated<MediaMarketView>>('/market/media', { ...q }),
  mediaById: (id: string) => get<MediaMarketView>(`/market/media/${id}`),
  incidents: (q: IncidentQuery = {}) => get<Paginated<IncidentView>>('/market/incidents', { ...q }),
  incident: (id: string) => get<IncidentDetail>(`/market/incidents/${id}`),
  /** Works for approved channels, admins (any status) and the owning uploader. */
  preview: (id: string) => post<PreviewSession>(`/market/media/${id}/preview`),
};

// ---------- Orders ----------
export const ordersApi = {
  create: (mediaId: string, licenseType: LicenseType) => post<CheckoutView>('/orders', { mediaId, licenseType }),
  verify: (id: string, razorpayPaymentId: string, razorpaySignature: string) =>
    post<OrderView>(`/orders/${id}/verify`, { razorpayPaymentId, razorpaySignature }),
  mockPay: (id: string) => post<OrderView>(`/orders/${id}/mock-pay`),
  list: (q: PageQuery & { status?: OrderStatus } = {}) => get<Paginated<OrderView>>('/orders', q),
  get: (id: string) => get<OrderView>(`/orders/${id}`),
  download: (id: string) => get<DownloadLink>(`/orders/${id}/download`),
};

// ---------- Admin ----------
export const adminApi = {
  stats: () => get<AdminStats>('/admin/stats'),
  reviewQueue: (q: PageQuery & { risk?: RiskLevel } = {}) => get<Paginated<ReviewItem>>('/admin/review-queue', q),
  approve: (id: string, note?: string) => post<MediaOwnerView>(`/admin/media/${id}/approve`, note ? { note } : {}),
  reject: (id: string, note: string) => post<MediaOwnerView>(`/admin/media/${id}/reject`, { note }),
  remove: (id: string, note: string) => post<MediaOwnerView>(`/admin/media/${id}/remove`, { note }),
  channels: (q: PageQuery & { status?: ChannelStatus } = {}) => get<Paginated<UserView>>('/admin/channels', q),
  approveChannel: (userId: string) => post<UserView>(`/admin/channels/${userId}/approve`),
  rejectChannel: (userId: string, note: string) => post<UserView>(`/admin/channels/${userId}/reject`, { note }),
  payouts: (q: PageQuery & { status?: PayoutStatus } = {}) => get<Paginated<AdminPayout>>('/admin/payouts', q),
  markPaid: (id: string, reference: string) => post<PayoutView>(`/admin/payouts/${id}/mark-paid`, { reference }),
  rejectPayout: (id: string, note: string) => post<PayoutView>(`/admin/payouts/${id}/reject`, { note }),
  refunds: (q: PageQuery & { status?: RefundStatus } = {}) => get<Paginated<AdminRefund>>('/admin/refunds', q),
  retryRefund: (id: string) => post<{ id: string; status: 'PENDING' }>(`/admin/refunds/${id}/retry`),
  orders: (q: PageQuery & { status?: OrderStatus } = {}) => get<Paginated<AdminOrder>>('/admin/orders', q),
  createAdjustment: (body: { uploaderEmail: string; amount: number; note: string }) =>
    post<LedgerEntryView & { uploaderId: string }>('/admin/ledger-adjustments', body),
  reports: (q: PageQuery & { status?: ReportStatus } = {}) => get<Paginated<Report>>('/admin/reports', q),
  resolveReport: (id: string, resolution: string, removeMedia: boolean) =>
    post<Report>(`/admin/reports/${id}/resolve`, { resolution, removeMedia }),
  dismissReport: (id: string, resolution: string) => post<Report>(`/admin/reports/${id}/dismiss`, { resolution }),
};

// ---------- Public reports ----------
export const reportsApi = {
  create: (body: { mediaId?: string; reporterEmail: string; reason: ReportReason; details?: string }) =>
    request<{ id: string; status: 'OPEN' }>('POST', '/reports', { body, auth: false }),
};
