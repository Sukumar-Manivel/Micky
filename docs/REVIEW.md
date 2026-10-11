# Micky pre-launch security and correctness review

- **Date:** 2026-10-11
- **Scope:** `apps/api`, `apps/web`, `services/verifier`, `infra/`, `scripts/`, `.github/workflows/` at `f40badc`, plus uncommitted work in the tree at the time.
- **Method:** I read the code end to end. I ran the API, the worker and the verifier locally against a scratch database (`micky_review`, Redis db 12) and probed them with curl and ffmpeg. I also ran `tsc`, the unit tests (91 passed), `npm audit --omit=dev` (0 vulnerabilities in api and web) and `pip-audit` (0 in the verifier).
- **Labels:**
  - "Verified" means I reproduced it.
  - "Traced" means I followed the code path end to end without running it.
  - "Plausible" means it depends on configuration I could not see.
- Line numbers were re-read just before writing. Code is changing concurrently, so check them again before fixing.

## Fix status (after the fix wave)

| Finding | Status |
|---|---|
| H1 Buyer charged with no refund path | Fixed: `REFUND_PENDING` → `REFUNDED`/`REFUND_FAILED` with an idempotent refund job, admin retry, and checkouts that expire after 30 min |
| H2 Refunds/chargebacks don't reverse credit | Fixed: credits held for `EARNINGS_HOLD_DAYS`, `SALE_REVERSAL` on refund or dispute, admin adjustments with an audit note |
| H3 Purchased original reveals the uploader | Fixed: buyers get a metadata-stripped delivery copy, re-checked before sale; the original stays admin-only |
| H4 Previews saved in full, no viewer named | Fixed: preview capped at min(30 s, 40%); per-newsroom renditions with the viewer burned in; viewer-bound 2-minute tokens; no previews after an exclusive sale |
| M1 Refresh-token race | Fixed: atomic claim in one transaction, plus a 30-day absolute session lifetime |
| M2 Open redirect | Fixed: same-origin URL check |
| M3 Reusable download links | Fixed: single-use, buyer-bound, 2-minute links; only completed downloads are counted |
| M4 Payout destination change | Fixed: password required, 24 h payout cooling-off, audit table |
| M5 Licence on an uncaptured payment | Fixed: auto-capture, and captured status, amount and currency verified |
| M6 Denial of service via media | Fixed: 50 MP / 4K limits, upload quotas, ffmpeg timeouts and pixel caps |
| M7 Backups unencrypted | Fixed: `age`-encrypted DB backups and backups of sold originals; the limits are documented |
| M8 Exact coordinates exposed | Fixed: rounded to ~100 m for newsrooms |
| M9 DPDP / IT Rules | Advisory: needs a lawyer before launch |
| L1–L10, Info | L1 accepted with throttling (no email yet); L2, L3, L5, L6, L8, L9 and L10 fixed; L4 and L7 open (scale items) |

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 4 |
| Medium | 9 |
| Low | 10 |
| Info | 5 |

There is no authentication bypass, no IDOR and no way to get an original file without paying. I tried other buyers' orders and downloads, other uploaders' media and previews, cross-role routes and an `alg:none` JWT; all returned 404/403/401. The payout double-spend and the exclusive-licence race are both handled correctly.

The serious problems are elsewhere:

1. What happens to money *after* the happy path: losing buyers, refunds and chargebacks.
2. What a paying channel learns about the uploader.
3. How much the "protected" preview actually protects.

---

## High

### H1. A buyer charged for a licence that is no longer available has no refund path (verified)

**Where:**
- `apps/api/src/orders/orders.service.ts:280-286`: `licence_unavailable` sets the order to `FAILED`.
- `orders.service.ts:327`: the only record is a log line.
- `orders.service.ts:356`: the buyer is promised a refund.
- `apps/web/components/license-panel.tsx:100`: "refunded automatically".

**What's wrong:**
- Checkout does not reserve anything. The licence is checked only when payment arrives.
- When the check fails, the captured payment is recorded as `status = FAILED`, the same state a declined card gets. The only differences are a `provider_payment_id` and an `ERROR` log line.
- No refund is issued through the Razorpay API.
- There is no `NEEDS_REFUND`/`REFUNDED` state and no admin queue.
- If the result arrives by webhook (the buyer closed the tab), the buyer is never told anything.

**Reproduced:**
1. Channels C1 and C2 each created an `EXCLUSIVE` order for the same video.
2. I paid both at the same moment.
3. C1 got `200 PAID`. C2 got `409 "...Your payment will be refunded in full"`.
4. In the database, C2's order was `FAILED`, with payment id set and amount 500000.
5. The only other trace was `NEEDS REFUND` in the log. Nothing in the system refunds it.

**Other ways to reach the same state:**
- Uploader deletes the media while a checkout is open (`media.service.ts` `remove` only blocks *paid* media).
- An admin takedown during checkout.
- A buyer paying twice for the same media.

Exclusive licences make competing payments a normal event, not an edge case.

**Fix:**
- Add an order state `REFUND_PENDING`, then `REFUNDED`.
- Call `razorpay.payments.refund(paymentId)` from an idempotent job keyed on the payment id. Retry it, and record the refund id.
- Show these orders in the admin dashboard.
- Optionally hold an exclusive licence for N minutes while an exclusive checkout is open.
- Change the web copy so it does not promise "automatic".

### H2. Refunds and chargebacks never reverse the uploader's credit, and the credit can be withdrawn immediately (traced)

**Where:**
- `apps/api/src/orders/razorpay-webhook.controller.ts:157-159`: every event other than paid/failed is ignored.
- `apps/api/src/earnings/earnings.service.ts:204-258`: payout against the full ledger balance.
- `schema.ts` `orderStatusEnum`: `CREATED | PAID | FAILED` only.

**What's wrong:**
- Nothing handles `refund.processed`, `payment.refunded` or `payment.dispute.*`. An order refunded in the Razorpay dashboard stays `PAID`, so the buyer keeps the download link (`stream.service.ts:137` only checks `PAID`).
- The `SALE_CREDIT` stays in the ledger.
- `SALE_CREDIT` is spendable the moment it is written. There is no settlement or hold period, and the `ADJUSTMENT` ledger type has no API.

**Exploit:**
1. A fraudster runs an uploader account and a channel account that has been approved.
2. They buy their own footage with a stolen card.
3. The uploader requests a UPI payout of 70% of the price, which an admin pays.
4. The chargeback arrives weeks later.
5. The platform loses 100% plus the chargeback fee, and the system still shows a healthy sale.

**Fix:**
- Make credits `PENDING` until Razorpay settlement plus a hold period (for example T+7). Allow payouts only from settled credits.
- Handle refund and dispute webhooks:
  - mark the order `REFUNDED` or `DISPUTED`;
  - revoke downloads;
  - write a negative `SALE_REVERSAL` ledger row. The balance may go negative, and future credits net it off.
- Add an admin `ADJUSTMENT` endpoint with an audit note.

### H3. The purchased original reveals who the uploader is: name, GPS and device (verified)

**Where:**
- `apps/api/src/stream/stream.service.ts:140`: `getStream(found.media.originalKey)` streams the untouched upload.
- Contradicts `docs/API.md:61,142` ("never contains the uploader's identity").
- Contradicts `apps/web/app/privacy/page.tsx:25` ("Newsrooms never see a witness's name").

**Reproduced:**
1. I uploaded a JPEG with EXIF `Artist="Priya Kumar (owner)"`, `Make`/`Model` and GPS 11.0168N 76.9558E, and a video with `location=+11.0168+076.9558/` and `make`/`model`.
2. After a mock purchase, the downloaded photo still had `Artist`, `Make`, `Model` and the full GPS IFD.
3. The downloaded video still had `make`, `model` and `location`.

Phone originals also carry body serial numbers, MakerNotes and sometimes the owner's name. A buyer can find the witness's home, or link several uploads to one device. For protest or crime footage, that can endanger the witness.

**Fix:**
- Decide on the policy with the uploader's consent.
- By default, deliver a copy without identifying tags:
  - JPEG/HEIC: rewrite with `exiftool -all= -tagsfromfile @ -DateTimeOriginal -Orientation`.
  - Video: `-map_metadata -1 -c copy`.
- Keep the capture time. Keep GPS only if the uploader opts in.
- Keep the untouched original for admins and evidence.
- Fix the privacy page so it says what buyers receive.

### H4. Anyone with a preview link can save the full preview in one command, and the saved copy names no viewer (verified)

**Where:**
- `stream.service.ts:96-101`: the AES key is served to the same bearer token as the segments.
- `stream.service.ts:67`: the viewer name is only `watermarkText`, which the browser draws on top of the video.
- `processing/ffmpeg.ts:10,198`: the burned-in mark is the fixed text "MICKY PREVIEW", and the preview is the first 30 s.
- `media-processing.service.ts:32`: photo previews are 1280 px.
- `preview-access.ts:35-37`: previews stay available after an exclusive sale.

**Reproduced:**
1. As channel C1, I called `POST /market/media/:id/preview`.
2. With no auth header, I ran `ffmpeg -i '<playlistUrl>' -c copy ripped.mp4`.
3. The result is a clean 12 s, 640×360 MP4: the whole clip.
4. Its only mark is the generic tiled "MICKY PREVIEW". The newsroom name is not in it, and GPS tags were correctly stripped.

**What follows:**
- Most eyewitness clips are under 30 s, so a non-paying channel gets the *entire* story at broadcast-usable 480p.
- A 1280 px photo preview is enough for a web article.
- After an exclusive sale, every other channel can still watch and save the preview, which weakens what the exclusive buyer paid for.
- The UI (`preview-player.tsx:32`, "Watermarked preview with your newsroom's name") and the docs (`docs/RESEARCH.md:76`, "Visible buyer marks make leaks traceable") promise attribution that a saved copy does not have.

**Fix:**
1. Burn the viewer's organisation name into the pixels. Either:
   - pre-render per channel on first view and cache it (cheap at this scale); or
   - add a per-session, segment-level forensic mark.
2. Cap the preview at a *fraction* of the clip. For example, `min(30 s, 40% of duration)`, or highlights with gaps.
3. Use 360p and heavier mark coverage for clips under 30 s.
4. Make photo previews 640 px with a burned-in viewer mark.
5. Stop previews for non-owners once `exclusiveSold` is set.
6. Correct the UI and research-doc wording.

---

## Medium

### M1. Refresh-token rotation can be raced, so one token gives two live sessions (verified)

**Where:** `apps/api/src/auth/auth.service.ts:76-100`.

**What's wrong:** The read (`stored.revokedAt` at :83), the new token (:90) and the revoke (:95-98) are separate statements with no lock or condition.

**Reproduced:**
1. I sent two `POST /auth/refresh` requests in parallel with the same cookie.
2. Both returned 200.
3. Both new cookies then refreshed successfully again.

A thief who replays a stolen cookie at the same time as the real client keeps a session that never triggers reuse detection.

**Fix:** In one transaction, run `UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`. Zero rows means reuse: revoke the family. Insert the replacement in the same transaction. Also add an absolute session lifetime; today each rotation extends the session by another 7 days, forever.

### M2. Open redirect after login (verified)

**Where:** `apps/web/app/login/login-form.tsx:11-12`.

**What's wrong:** `safeNext` accepts any path that starts with `/` but not `//`. The URL parser turns `/\evil.example` and `/<TAB>/evil.example` into `https://evil.example/`; I confirmed this with Node's WHATWG `URL`. Next's `router.replace` treats a different origin as external and calls `location.replace` (`next/dist/client/components/app-router.js` `mpaNavigation`).

**Exploit:** Send `https://micky.in/login?next=/%5Cevil.example/login` to a newsroom. After a real login, the user lands on a look-alike page saying "session expired, sign in again".

**Fix:** Resolve the URL with `new URL(next, location.origin)`, require `url.origin === location.origin`, then redirect to `url.pathname + url.search`. Or allow-list known path prefixes.

### M3. Download links are bearer URLs that can be reused and shared, and `downloadCount` counts link requests (verified)

**Where:**
- `apps/api/src/common/urls.service.ts:44-50`: the token is `{o: orderId}` only.
- `stream.service.ts:127-141`.
- `orders.service.ts:426`.

**Reproduced:** I fetched one download URL three times with no authentication. All three returned 200 with the full original, and `downloadCount` stayed 1.

**Impact:** A non-exclusive buyer can post the link to a partner newsroom, which downloads within 15 minutes. The count gives no evidence of how many downloads happened.

**Fix:**
- Bind the token to the buyer (`u`) and make it single-use (a nonce row consumed on the first byte).
- Increment the count in the file route, not when the link is minted.
- Shorten the lifetime to about 2 minutes.

### M4. Payout destination can be changed with no re-authentication or notice (traced)

**Where:** `apps/api/src/earnings/earnings.service.ts:86-98` (`PUT /me/payout-details`) and `:204` (payout).

**What's wrong:** Anyone with a valid access token, for example after a stolen refresh cookie (see M1), can set their own UPI ID and request the whole balance in two calls. The uploader gets no email, and there is no cooling-off period.

**Fix:**
- Require the password, or an email OTP, to change the UPI ID.
- Email the account on change.
- Block payouts for 24–48 h after a change.
- Show "UPI changed recently" in the admin payout queue.

### M5. `/verify` grants the licence on a payment that may only be *authorised*, not captured (plausible)

**Where:** `orders.service.ts:178-194`, `razorpay.provider.ts:44-49`.

**What's wrong:** The checkout signature is issued at authorisation. If the Razorpay account is not set to auto-capture, or the capture window lapses, Razorpay auto-refunds the payment. The buyer keeps the original and the uploader keeps a credit for money that never arrived. Neither `docs/DEPLOYMENT.md` nor `orders.create` pins auto-capture.

**Fix:**
- Document and verify "Payment capture: automatic" in the dashboard.
- In `verify`, fetch the payment (`payments.fetch`) and require `status === 'captured'` and `amount === order.amount`.
- Or treat `/verify` as "pending" and grant only on the `payment.captured` webhook.

### M6. Uploads and processing can be abused to deny service (verified in part)

**Where:**
- `apps/api/src/media/media.module.ts:25`: 500 MB multer limit for *every* file, before the type is known.
- No per-account upload quota.
- `WORKER_CONCURRENCY=1` with a 10-minute ffmpeg timeout per command (`ffmpeg.ts:24`).

**What can happen:**
- Any self-registered uploader can push 100 requests/min × 500 MB to `/data/tmp`, filling the disk shared with Postgres' host.
- They can also queue many 10-minute videos, starving the single worker for every real witness.

**Measured:** a 790 KB PNG of 16000×16000 px made ffmpeg allocate 811 MB RSS for one render. Processing renders it about 4 times. That is harmless at concurrency 1 under the 2 GB worker limit, but raising concurrency risks OOM-kills.

**Fix:**
- Per-user limits: uploads per hour, bytes per day, and jobs in flight (for example 3).
- Check width × height after `ffprobe` (for example ≤ 50 MP for photos, ≤ 4K for video) and fail permanently.
- Put the upload tmp directory on a size-limited volume.
- Give each user a fair share of the queue (BullMQ groups or a per-user job cap).

### M7. Backups hold all personal data unencrypted, and purchased originals are not backed up at all (traced)

**Where:**
- `scripts/backup-db.sh:50-63`: a gzip `pg_dump` uploaded to R2. It contains emails, password hashes, UPI IDs, exact GPS and full EXIF metadata, with no client-side encryption.
- `scripts/restore-db.sh:15`: "Media files ... are NOT part of this backup."

**Impact:**
- A leaked R2 token, which also sits in the app containers' environment (see L3), exposes every user.
- A failure of the single VM disk loses every original, including ones channels have paid for. Today a buyer who re-downloads after a disk loss gets a 404.

**Fix:**
- Encrypt dumps with `age`/`gpg` to a public key kept off the server.
- Enable R2 object lock or versioning so a compromised server cannot delete backups.
- Back up `originals/` with `rclone sync`, at least for media that has orders.

### M8. Witnesses' exact coordinates are published to every approved channel (traced)

**Where:** `apps/api/src/common/views.ts:149-150` (`MediaMarketView`), and the incident location copied from the first upload (`incidents.service.ts` `assignIncident`).

**What's wrong:** Channels receive the uploader-entered coordinates at full precision; I saw `11.016844, 76.955832`. The upload form offers a "use my location" button (`upload-form.tsx:72-76`) that fills in the device's position. The published point is therefore often where the witness was standing, for example their own balcony.

**Fix:** In market views, round to about 3 decimals (~100 m) or to the geohash-6 cell centre. Show exact coordinates only after purchase, and only if the uploader agrees (see H3).

### M9. DPDP Act and IT Rules gaps (advisory)

I compared the code with `docs/RESEARCH.md:43-55`.

- **No deletion or export.** No account deletion endpoint exists, and data requests are a sentence on the privacy page with no contact address.
- **Nothing is ever deleted:**
  - originals of `REMOVED`, `REJECTED` and `FAILED` media are kept forever (`media.service.ts:215`);
  - verification metadata with GPS is kept forever;
  - refresh-token rows are never pruned.
  This conflicts with data minimisation and storage limitation.
- **Consent.** The only consent captured is `rightsConfirmed`. There is no versioned consent notice or consent record per user and purpose (needed by May 2027), and no age gate, although minors may well upload.
- **Grievances (IT Rules):**
  - The privacy and terms pages name no Grievance Officer.
  - The reporter gets no acknowledgement.
  - New reports only produce a `logger.warn` (`reports.service.ts`), with no alert. The 2-hour NCII and 3-hour government-order deadlines cannot be met without paging someone.
  - Reports have no SLA fields (`due_at`).
- **Logs.** Docker log rotation keeps 30 MB per container (`infra/docker-compose.prod.yml:22-23`). CERT-In requires logs for 180 days, and DPDP Rules require one year.
- **Synthetic media labelling.** The AI score is shown, but nothing marks content as AI-generated when an admin knowingly approves it. The amended IT Rules require a clear label.
- **Tax.** The PAN collection required for TDS under 194-O (`RESEARCH.md:31,39`) is not implemented. Payouts work without a PAN.

**Fix:**
- Add `DELETE /me` (anonymise the user; keep financial rows as the law requires) and a contact email.
- Run a retention job that deletes non-sold originals N days after `REMOVED`/`REJECTED`/`FAILED`.
- Store consent records with notice versions.
- Show a Grievance Officer block, send an acknowledgement email, and page the admin on `PRIVACY` and `GRAPHIC` reports.
- Ship logs to a store kept for 180 or more days.
- Collect PAN before the first payout.

---

## Low

**L1. Account enumeration on registration.** `auth.service.ts:40` returns 409 "An account with this email already exists". Login avoids enumeration by comparing against a dummy hash, so registration undoes that. Fix: always answer 201/202 and send an email instead. Without email this is an accepted trade-off; at minimum, throttle it.

**L2. Brute-force protection is per IP and per process only.**
- The throttler uses in-memory storage (`app.module.ts:38`) and limits login to 10/min per IP (`auth.controller.ts:31`).
- There is no per-account lockout or backoff, so a password-spraying botnet is unlimited.
- `trust proxy 1` (`main.ts:22`) is correct only while Caddy is the sole hop. Behind an orange-cloud Cloudflare proxy, every client would share Cloudflare's IP.

Fix: count failures per account in Redis, and use the Redis throttler storage.

**L3. Secrets spread wider than needed.**
- `env_file: .env` (`infra/docker-compose.prod.yml:27`) loads `BACKUP_S3_*`, `ADMIN_PASSWORD` and `POSTGRES_PASSWORD` into the api, worker, migrate and seed containers.
- The worker also sits on the internet-facing `edge` network (`:185`) while it parses untrusted media with ffmpeg.

Fix: pass each service only the variables it needs. With `STORAGE_DRIVER=local`, keep the worker on `backend` only.

**L4. Trend score double-counts views and anyone can inflate it.**
- `market.service.ts:137,143` increments both `media.view_count` and `incidents.view_count` on every `GET /market/media/:id`.
- `incidents.service.ts:156` then adds the two, so each view counts twice.
- The comment there says "views of the incident page", but `getIncident` never counts views.
- Views are not deduplicated per channel, so one newsroom refreshing a page can push its own story up the ranking.

Fix: count distinct (channel, media) per day in a separate table, and use one source of truth.

**L5. Weak webhook checks.**
- `razorpay-webhook.controller.ts:138` skips the amount check when `amount` is missing.
- It never checks `currency === 'INR'` or `order.provider === 'razorpay'`.
- `x-razorpay-event-id` is not covered by the signature (harmless today because `markPaid` is idempotent).

**L6. No database-level money constraints.**
- No `CHECK (amount > 0 AND platform_fee + uploader_share = amount)`.
- No partial unique index enforcing one `PAID` `EXCLUSIVE` order per media.
- Nothing enforces that the ledger is append-only, although the schema comment claims it (a trigger or `REVOKE UPDATE, DELETE`).

The application logic is correct today. These would make it hold when a future change gets it wrong.

**L7. Duplicate search scans every verification row per upload.** `media-processing.service.ts:369` pages through *all* verifications and compares pHashes in JavaScript. It is O(N) per upload and becomes the worker's slowest step after about 100k uploads. Fix: BK-tree, `pg_similarity`, or band and bucket the 64-bit hashes into an indexed column.

**L8. Two different download filenames for the same file.**
- `orders/order-view.ts:67` (the API response's `fileName`) lower-cases the name and uses the extension of the *client's* filename.
- `stream/stream.service.ts:228` (`Content-Disposition`) keeps the case and uses the extension of the storage key.

The JSON says `review-fire-photo-3047.jpg` while the browser saves `Review-fire-photo-3047.jpg`. Keep one function.

**L9. CI/CD supply chain.**
- Actions are pinned to mutable tags (`actions/checkout@v5`, `docker/*@v3/v6`), not SHAs.
- The deploy falls back to trust-on-first-use `ssh-keyscan` when `SSH_KNOWN_HOSTS` is unset (`deploy.yml:189`). Make it required.
- The deploy user is in the `docker` group (root-equivalent), so the GitHub-held SSH key is effectively root on the VM. Restrict it to a forced command in `authorized_keys` that runs only `deploy.sh`.

**L10. No Content-Security-Policy on the web app** (`apps/web/next.config.ts:4-11`; Caddy adds none either). I found no XSS: there is no `dangerouslySetInnerHTML`, and Leaflet uses static `divIcon` HTML. A CSP is still the safety net for a page that takes payments. Allow `script-src 'self' https://checkout.razorpay.com`, `frame-src https://api.razorpay.com`, the API origin in `connect-src`/`media-src`/`img-src`, and use `frame-ancestors 'none'`.

## Info

- **I1.** `incident.updated` events from the scheduled 5-minute trend recompute never reach clients. The recompute runs in the worker, where `RealtimeService` is absent (`incidents.service.ts:174`, `@Optional()` realtime). Live trend changes only arrive on approve or remove.
- **I2.** `apps/api/tsconfig.build.tsbuildinfo` is committed and changes on every build. `dump.rdb`, a Redis snapshot from a redis-server started in the repo root, is ignored but present. Remove both.
- **I3.** bcrypt ignores everything after 72 bytes, but `LoginDto` and `RegisterDto` allow 128 characters. Either cap at 72 bytes or pre-hash.
- **I4.** Channels can see `duplicateOfId` (`risk.ts:116`, `views.ts`), which links one upload to another, possibly by a different uploader. They can also see the C2PA issuer string, which may be a person's name for personal signing certificates.
- **I5.** A channel whose approval is revoked can still `verify` an open order and download what it bought (`orders.controller.ts`: `@Roles('CHANNEL')` without `@ApprovedChannel()`). That is probably intended, but write it down; revoking a channel for leaking currently does not stop its downloads.

---

## What's done well

- **One `markPaid` for every payment path:**
  - `SELECT … FOR UPDATE` on the media row;
  - re-reading the order under the lock;
  - a conditional `status <> 'PAID'` update;
  - a partial unique index for "one SALE_CREDIT per order".
  The exclusive race and the webhook-versus-client race resolved correctly under real concurrency.
- **Payment and webhook signatures:**
  - payment signatures are checked against the provider order id *from the database*;
  - webhook HMAC is computed over the raw body;
  - both use `timingSafeEqual`;
  - event ids are deduplicated, and the claim is released on failure so Razorpay's retry works.
- **Payouts:**
  - a transaction-scoped advisory lock per uploader: 4 parallel ₹3,000 payouts against a ₹3,850 balance produced exactly one;
  - the ledger is debited when the payout is requested and reversed on rejection.
- **Money in paise:**
  - every amount is an integer number of paise, end to end;
  - the platform fee is rounded down in the uploader's favour.
- **Access checks:**
  - every `:id` route filters by owner and returns 404 (not 403) for other people's records;
  - stream tokens are re-authorised against fresh database state on *every* segment and key request;
  - `ParseUUIDPipe` is used everywhere.
- **Previews:**
  - GPS and device tags are stripped (`-map_metadata -1`), checked on the preview JPEG and the ripped HLS;
  - the AES key lives in the database rather than storage;
  - segment names are allow-listed by a regex;
  - storage keys are never built from user input.
- **Upload handling:**
  - magic-byte sniffing;
  - `spawn` with argument arrays (no shell);
  - multer writes to disk under a random name;
  - temp files are removed in `finally`.
- **Worker retries:** each step is idempotent, and `UnrecoverableError` stops retries for bad files.
- **Verifier service:**
  - authentication and body-size limits run as raw ASGI middleware before the body is read;
  - Pillow's decompression-bomb limit is enforced;
  - non-root container;
  - pinned model revision;
  - no public OpenAPI.
- **Browser sessions:**
  - access tokens are kept only in memory;
  - the refresh cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production and scoped to the `/api/v1/auth` path;
  - refresh is single-flight across tabs.
- **Deployment:**
  - in production the API refuses to start with missing or short secrets or the mock provider;
  - Postgres, Redis and the verifier sit on an `internal: true` network;
  - non-root images;
  - least-privilege workflow permissions;
  - the deploy tag is validated before it reaches the remote shell.

## Fix order

1. **H1 + H2:** refund state and automatic refunds, refund and dispute webhooks, `SALE_REVERSAL` ledger rows, and a settlement hold before payouts. Do this before taking live money.
2. **H3 + M8:** strip identifying metadata from delivered originals (consent-based GPS), coarsen coordinates in the market, and correct the privacy page.
3. **H4:** burn per-viewer marks into previews, take only part of short clips, use smaller photo previews, and stop previews after an exclusive sale. Correct the UI and research wording.
4. **M5:** require `captured` before granting a licence.
5. **M1, M4, M2:** atomic refresh rotation, re-authentication and a cooling-off period for UPI changes, and a proper same-origin check for `next`.
6. **M3:** single-use download links bound to the buyer.
7. **M6:** per-user upload and job quotas and a pixel-count limit.
8. **M7:** encrypted, object-locked backups, plus a backup of `originals/`.
9. **M9:** account deletion and retention job, Grievance Officer and report alerting, 180-day logs, PAN before payout.
10. Low and Info items as normal hygiene; L6 and L10 are cheap and worth doing with the items above.
