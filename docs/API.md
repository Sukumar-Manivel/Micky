# API contract

This is the single source of truth for the HTTP API. The backend implements it and the web app consumes it. If you need to change it, change this file first.

- **Base URL:** `{PUBLIC_API_URL}/api/v1` (development: `http://localhost:4000/api/v1`)
- **Format:** JSON, except uploads (`multipart/form-data`) and streams.
- **Auth:** `Authorization: Bearer <accessToken>` on every route unless marked **public**.
- **Money:** always **integer paise** (₹1 = 100 paise). The web app formats for display.
- **Dates:** ISO 8601 strings in UTC.
- **Errors:** NestJS default shape, `{ "statusCode": 400, "message": "..." | ["..."], "error": "Bad Request" }`. Codes used: 400 validation, 401 not logged in, 403 not allowed, 404 not found, 409 conflict (e.g. already sold), 413 file too large, 415 unsupported file type, 429 rate limited.
- **Pagination:** list endpoints take `?page=1&pageSize=20` (max 100) and return `{ items, page, pageSize, total }`.

## Shared types

```ts
type Role = 'UPLOADER' | 'CHANNEL' | 'ADMIN';
type Category = 'FIRE' | 'ACCIDENT' | 'FLOOD' | 'WEATHER' | 'PROTEST' | 'CRIME' | 'INFRASTRUCTURE' | 'OTHER';
type MediaType = 'VIDEO' | 'PHOTO';
type MediaStatus = 'PROCESSING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'FAILED' | 'REMOVED';
type LicenseType = 'NON_EXCLUSIVE' | 'EXCLUSIVE';
type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

interface UserView {
  id: string; email: string; name: string; role: Role; createdAt: string;
  channel: { organization: string; website: string | null; status: 'PENDING' | 'APPROVED' | 'REJECTED' } | null;
  uploader: { upiId: string | null } | null;
}

interface Signal { code: string; level: 'info' | 'warning' | 'danger' | 'positive'; message: string }

interface VerificationView {
  riskLevel: RiskLevel;
  aiScore: number | null;        // 0..1, null when the detector was unavailable
  aiModel: string | null;
  c2paStatus: 'valid' | 'invalid' | 'absent' | 'error' | 'unsupported';
  c2paIssuer: string | null;
  duplicateOfId: string | null;
  signals: Signal[];
  metadata: Record<string, unknown>; // full metadata: ADMIN only, {} for everyone else
}

/** What the uploader sees about their own upload. */
interface MediaOwnerView {
  id: string; type: MediaType; status: MediaStatus; title: string; description: string | null;
  category: Category; latitude: number; longitude: number; locationName: string | null;
  capturedAt: string; createdAt: string; durationSec: number | null; width: number | null; height: number | null;
  priceNonExclusive: number; priceExclusive: number; exclusiveSold: boolean;
  thumbnailUrl: string | null;    // signed, expires in 1 hour
  reviewNote: string | null; processingError: string | null;
  salesCount: number; earned: number; // paise credited to the uploader for this media
  verification: VerificationView | null;
}

/** What a news channel sees in the marketplace. Never contains the uploader's identity. */
interface MediaMarketView {
  id: string; type: MediaType; title: string; description: string | null; category: Category;
  latitude: number; longitude: number; locationName: string | null;
  capturedAt: string; publishedAt: string; durationSec: number | null; width: number | null; height: number | null;
  thumbnailUrl: string | null;    // signed, expires in 1 hour
  incidentId: string | null;
  priceNonExclusive: number; priceExclusive: number;
  availability: { nonExclusive: boolean; exclusive: boolean };
  purchased: { orderId: string; licenseType: LicenseType } | null; // the caller's own paid purchase, if any
  verification: VerificationView; // metadata is {} for channels
  distanceKm?: number;            // only when lat/lng were given
}

interface IncidentView {
  id: string; title: string; category: Category; latitude: number; longitude: number;
  locationName: string | null; firstSeenAt: string; lastSeenAt: string;
  mediaCount: number; uploaderCount: number; trendScore: number;
  thumbnailUrl: string | null;    // thumbnail of its newest approved media
}

interface OrderView {
  id: string; status: 'CREATED' | 'PAID' | 'FAILED'; licenseType: LicenseType;
  amount: number; currency: 'INR'; createdAt: string; paidAt: string | null; downloadCount: number;
  media: { id: string; title: string; type: MediaType; thumbnailUrl: string | null };
}

interface LedgerEntryView {
  id: string; type: 'SALE_CREDIT' | 'PAYOUT_DEBIT' | 'PAYOUT_REVERSAL' | 'ADJUSTMENT';
  amount: number; note: string | null; createdAt: string;
  mediaTitle: string | null;      // for sale credits
}

interface PayoutView {
  id: string; amount: number; upiId: string; status: 'REQUESTED' | 'PAID' | 'REJECTED';
  reference: string | null; note: string | null; createdAt: string; processedAt: string | null;
}
```

## Auth (implemented)

The refresh token lives only in the httpOnly cookie `ff_refresh` (path `/api/v1/auth`). The web app keeps the access token in memory and calls `/auth/refresh` with `credentials: 'include'` on page load and on any 401.

| Method | Path | Access | Body → Response |
|---|---|---|---|
| POST | `/auth/register` | public, 10/min | `{ email, password (8–128), name (2–80), role: 'UPLOADER' \| 'CHANNEL', organization? (required for CHANNEL), website? }` → **201** `{ accessToken, user: UserView }` + cookie |
| POST | `/auth/login` | public, 10/min | `{ email, password }` → `{ accessToken, user }` + cookie |
| POST | `/auth/refresh` | public (cookie) | → `{ accessToken, user }` + rotated cookie. 401 clears the cookie |
| POST | `/auth/logout` | public (cookie) | → **204** |
| GET | `/auth/me` | any user | → `{ user: UserView }` |
| GET | `/health` | public | → `{ status: 'ok', database: 'up', time }` |

## Uploader: media (MediaModule)

| Method | Path | Access | Request → Response |
|---|---|---|---|
| POST | `/media` | UPLOADER | `multipart/form-data` (fields below) → **201** `MediaOwnerView` with `status: 'PROCESSING'` |
| GET | `/me/media` | UPLOADER | `?page&pageSize&status?` → `Paginated<MediaOwnerView>`, newest first |
| GET | `/me/media/:id` | UPLOADER (owner) | → `MediaOwnerView` |
| PATCH | `/me/media/:id` | UPLOADER (owner) | `{ title?, description?, priceNonExclusive?, priceExclusive? }` (paise; only while not sold) → `MediaOwnerView` |
| DELETE | `/me/media/:id` | UPLOADER (owner) | → **204**. Sets status `REMOVED`. 409 if it has any paid order |

**Upload fields:**

| Field | Type | Rules |
|---|---|---|
| `file` | binary, required | Video: mp4/mov/webm (≤ `MAX_VIDEO_BYTES`, default 500 MB). Photo: jpeg/png/heic/webp (≤ 25 MB). The file type is checked from its magic bytes, not the extension |
| `title` | string, required | 5–120 characters |
| `description` | string, optional | ≤ 2000 characters |
| `category` | Category, required | |
| `latitude` | number, required | −90..90 |
| `longitude` | number, required | −180..180 |
| `locationName` | string, optional | ≤ 200 characters |
| `capturedAt` | ISO date, required | Not in the future (5 min allowance), not older than 30 days |
| `priceNonExclusive`, `priceExclusive` | paise, optional | Defaults by type. Allowed range ₹100–₹1,00,000; exclusive ≥ non-exclusive |
| `rightsConfirmed` | `'true'`, required | Uploader confirms they shot it, it is real, and they accept the uploader licence |

Duplicate check: if the same file checksum was already uploaded by anyone, reject with 409 `This file has already been uploaded`.

## Marketplace (MarketModule)

Access: CHANNEL with an **approved** organisation, or ADMIN. Only `APPROVED` media is listed, and the uploader's identity is never exposed.

| Method | Path | Request → Response |
|---|---|---|
| GET | `/market/media` | `?category&type&lat&lng&radiusKm (1–500, default 50 when lat/lng given)&sinceHours (1–720)&sort=recent\|trending\|nearest&q (search in title/description/locationName)&page&pageSize` → `Paginated<MediaMarketView>` |
| GET | `/market/media/:id` | → `MediaMarketView`. Increments `viewCount` |
| GET | `/market/incidents` | `?category&sinceHours (default 72)&lat&lng&radiusKm&sort=trending\|recent&page&pageSize` → `Paginated<IncidentView>`. Only incidents with mediaCount > 0 |
| GET | `/market/incidents/:id` | → `IncidentView & { media: MediaMarketView[] }` |

## Preview streaming (StreamModule)

| Method | Path | Access | Response |
|---|---|---|---|
| POST | `/market/media/:id/preview` | approved CHANNEL, or ADMIN (any status), or the owner UPLOADER | `{ kind: 'hls', playlistUrl, expiresAt, watermarkText }` for video, or `{ kind: 'image', imageUrl, expiresAt, watermarkText }` for photos. URLs are absolute and signed (10 min). `watermarkText` is e.g. `"Preview · <organisation> · <date>"`; the player overlays it, moving |
| GET | `/stream/:token/index.m3u8` | public (token) | HLS playlist (`application/vnd.apple.mpegurl`). Segment and key URIs are relative, so they resolve to the routes below with the same token |
| GET | `/stream/:token/:segment` | public (token) | `.ts` segment (`video/mp2t`). Names must match `^seg_\d{3,5}\.ts$` |
| GET | `/stream/:token/key.bin` | public (token) | 16-byte AES-128 key (`application/octet-stream`), `Cache-Control: no-store` |
| GET | `/stream/:token/image.jpg` | public (token) | Watermarked preview image |
| GET | `/files/thumb/:token` | public (token) | Watermarked thumbnail JPEG, `Cache-Control: private, max-age=3600` |
| GET | `/files/download/:token` | public (token) | The **original** file, as an attachment. Token from `/orders/:id/download` only |

Signed token purposes (see `SigningService`): `stream` `{ m: mediaId, u: userId }`, `thumb` `{ m }`, `download` `{ o: orderId }`.

## Orders and payments (OrdersModule)

| Method | Path | Access | Request → Response |
|---|---|---|---|
| POST | `/orders` | approved CHANNEL | `{ mediaId, licenseType }` → **201** `CheckoutView` (below). 409 if the licence is unavailable or already bought by this channel |
| POST | `/orders/:id/verify` | buyer | `{ razorpayPaymentId, razorpaySignature }` → `OrderView` (PAID). Signature checked as documented in RESEARCH.md |
| POST | `/orders/:id/mock-pay` | buyer, only when `PAYMENTS_PROVIDER=mock` | → `OrderView` (PAID). 404 when the provider is not mock |
| GET | `/orders` | CHANNEL | `?page&pageSize&status?` → `Paginated<OrderView>` |
| GET | `/orders/:id` | buyer or ADMIN | → `OrderView` |
| GET | `/orders/:id/download` | buyer, PAID only | → `{ url, expiresAt, fileName }`, a signed absolute URL to `/files/download/:token`, valid 15 min. Increments `downloadCount` |
| POST | `/payments/razorpay/webhook` | public, signature-checked | Razorpay event → **200** `{ received: true }`. Idempotent via `webhook_events` |

```ts
interface CheckoutView {
  orderId: string; amount: number; currency: 'INR'; provider: 'razorpay' | 'mock';
  razorpay?: { keyId: string; orderId: string }; // pass to Razorpay Checkout
  description: string;                           // e.g. "Non-exclusive licence: Fire near Gandhipuram"
}
```

**Licence rules:**
- **Exclusive** can be bought only if the media has **no** paid orders yet. After it is paid, the media is no longer available to anyone else, and `exclusiveSold = true`.
- **Non-exclusive** can be bought by many channels, but not after an exclusive sale. Each channel can buy each media once.
- **Two buyers racing for an exclusive licence:** marking an order PAID locks the media row (`SELECT ... FOR UPDATE`) and re-checks the rules. If the licence was taken in the meantime, the order is marked FAILED and flagged for refund in the logs.

**Marking an order PAID happens in exactly one service method, used by verify, mock-pay and the webhook, in one transaction:**
1. Set the order to PAID (only if it is CREATED: idempotent).
2. Insert a `SALE_CREDIT` ledger entry of `uploaderShare` (the unique index makes this idempotent).
3. Update `exclusiveSold`.

## Uploader earnings (EarningsModule), UPLOADER only

| Method | Path | Request → Response |
|---|---|---|
| PUT | `/me/payout-details` | `{ upiId }` (format `name@bank`, 3–100 chars) → `{ user: UserView }` |
| GET | `/me/earnings` | → `{ balance, totalEarned, totalPaidOut, pendingPayouts, salesCount, recent: LedgerEntryView[] (last 10) }` (paise) |
| GET | `/me/ledger` | `?page&pageSize` → `Paginated<LedgerEntryView>` |
| GET | `/me/sales` | `?page&pageSize` → `Paginated<{ orderId, mediaId, mediaTitle, licenseType, amount, uploaderShare, paidAt, buyerOrganization }>` |
| POST | `/me/payouts` | `{ amount }` (paise, ≥ `MIN_PAYOUT_PAISE`, ≤ balance, UPI ID set) → **201** `PayoutView`. Debits the ledger immediately, in one transaction that locks the user's ledger (`pg_advisory_xact_lock`) to prevent double spending |
| GET | `/me/payouts` | `?page&pageSize` → `Paginated<PayoutView>` |

## Admin (AdminModule), ADMIN only

| Method | Path | Request → Response |
|---|---|---|
| GET | `/admin/stats` | → `{ users: { uploaders, channels, pendingChannels }, media: { processing, inReview, approved, rejected }, orders: { paid, revenue, platformFees }, payouts: { requested, requestedAmount }, reports: { open } }` |
| GET | `/admin/review-queue` | `?page&pageSize&risk?` → `Paginated<MediaOwnerView & { uploader: { id, name, email } }>`, oldest first, status IN_REVIEW. Verification includes full metadata |
| POST | `/admin/media/:id/approve` | `{ note? }` → `MediaOwnerView`. IN_REVIEW → APPROVED, then `IncidentsService.recompute` and `RealtimeService.emitToChannels({ type: 'media.approved', ... })` |
| POST | `/admin/media/:id/reject` | `{ note }` (required, 3–500 chars) → `MediaOwnerView` |
| POST | `/admin/media/:id/remove` | `{ note }` → takedown of APPROVED media (status REMOVED) and incident recompute |
| GET | `/admin/channels` | `?status=PENDING\|APPROVED\|REJECTED&page&pageSize` → `Paginated<UserView>` |
| POST | `/admin/channels/:userId/approve` | → `UserView` |
| POST | `/admin/channels/:userId/reject` | `{ note }` → `UserView` |
| GET | `/admin/payouts` | `?status&page&pageSize` → `Paginated<PayoutView & { uploader: { id, name, email } }>` |
| POST | `/admin/payouts/:id/mark-paid` | `{ reference }` → `PayoutView` |
| POST | `/admin/payouts/:id/reject` | `{ note }` → `PayoutView` + a `PAYOUT_REVERSAL` ledger entry that returns the money |
| GET | `/admin/reports` | `?status&page&pageSize` → `Paginated<Report>` |
| POST | `/admin/reports/:id/resolve` | `{ resolution, removeMedia?: boolean }` → Report |
| POST | `/admin/reports/:id/dismiss` | `{ resolution }` → Report |

## Public reports (ReportsModule)

| Method | Path | Access | Request → Response |
|---|---|---|---|
| POST | `/reports` | public, 5/min | `{ mediaId?, reporterEmail, reason: 'PRIVACY' \| 'COPYRIGHT' \| 'FAKE' \| 'GRAPHIC' \| 'OTHER', details? (≤ 2000) }` → **201** `{ id, status: 'OPEN' }` |

## Realtime (Socket.IO)

- **Connection:** URL `{PUBLIC_API_URL}`, path `/socket.io`, namespace `/live`. Authenticate with `io(url + '/live', { auth: { token: accessToken } })`. Only approved CHANNEL users and ADMINs stay connected; others are disconnected with an `error` event.
- **Server → client events:**
  - `media.approved`: `{ mediaId, incidentId, title, category }`
  - `incident.updated`: `{ incidentId, trendScore, mediaCount }`

## Internal: worker → verifier service

```
POST {VERIFIER_URL}/v1/analyze
Header: X-Internal-Token: {INTERNAL_TOKEN}
multipart/form-data:
  media_type: "VIDEO" | "PHOTO"
  frames:     1..16 JPEG files (sampled frames, or the photo itself)
  original:   optional original file (sent when ≤ 50 MB) for C2PA checking
→ 200 {
  "ai":     { "available": bool, "score": float|null, "model": str|null, "frames_scored": int,
              "frame_scores": [float] },
  "c2pa":   { "status": "valid"|"invalid"|"absent"|"error"|"unsupported",
              "issuer": str|null, "claim_generator": str|null },
  "phash":  ["<16 hex chars>", ...]   // one per frame, same order
}
GET {VERIFIER_URL}/health → { "status": "ok", "ai_model_loaded": bool }
```

The worker turns this, plus `ffprobe`/EXIF metadata and the duplicate search, into a `verifications` row with signals and a risk level.
