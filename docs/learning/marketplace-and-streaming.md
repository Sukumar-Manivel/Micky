# Marketplace, preview streaming and realtime

This note covers the part of Micky that news channels use: browsing approved footage, watching protected previews, downloading what they bought, and getting live "new footage" alerts.

## 1. What was built and why

| Module | Folder | What it does |
|---|---|---|
| **MarketModule** | `apps/api/src/market/` | `GET /market/media`, `/market/media/:id`, `/market/incidents`, `/market/incidents/:id`. Search, filter, sort and paginate **approved** footage. The uploader's identity is never exposed |
| **StreamModule** | `apps/api/src/stream/` | `POST /market/media/:id/preview` creates a 10-minute preview session. Public, token-protected routes serve the HLS playlist, encrypted segments, the AES key, preview images, thumbnails and paid downloads |
| **RealtimeModule** | `apps/api/src/realtime/` | Socket.IO gateway on `/live`. Approved channels and admins get `media.approved` and `incident.updated` events pushed to them |

**Why:** a channel must be able to judge footage before paying, but the footage is the product. So the design is:
- Channels can **see** a low-quality, watermarked, encrypted preview through links that expire in minutes.
- The **original** file only leaves the server after a PAID order.

## 2. How a request flows (file by file)

### Listing the marketplace: `GET /api/v1/market/media?lat=10&lng=76.3&sort=nearest`

1. `main.ts`: the global `ValidationPipe` turns the query string into a `MarketMediaQuery` (`market/market.dto.ts`). `@Type(() => Number)` converts `"10"` to `10`. `class-validator` checks ranges (lat −90..90, radiusKm 1..500, pageSize ≤ 100). Unknown parameters are rejected (`forbidNonWhitelisted`).
2. `app.module.ts` guards run in order:
   - `ThrottlerGuard`: 100 requests/min per IP.
   - `JwtAuthGuard`: valid Bearer token.
   - `RolesGuard`: reads `@Roles('CHANNEL','ADMIN')` and `@ApprovedChannel()` from `market.controller.ts`. For a CHANNEL it loads `channel_profiles.status` and returns 403 unless the status is APPROVED.
3. `market.controller.ts` calls `MarketService.listMedia(user, query)`.
4. `market.service.ts`:
   - Builds a list of SQL conditions: `status = 'APPROVED'`, category, type, `captured_at >= now - sinceHours`, and ILIKE search with escaped wildcards (`geo.ts: escapeLike`).
   - Adds the radius condition from `geo.ts: withinRadius`: a bounding box, then the exact haversine distance.
   - Runs **two queries in parallel**: one for the page of rows (with `distance` as an extra column), one for the total.
   - `toMarketViews` loads verifications, PAID order counts and the caller's own PAID orders for **all rows of the page at once** (3 queries, using `IN (...)`).
   - Maps each row with `toMediaMarketView` (`common/views.ts`). That mapper has no uploader fields, which makes "never expose the uploader" structural rather than something to remember. Full verification metadata (GPS, device) is included only for ADMIN.
   - **Coordinates are rounded** to 3 decimals (about 100 m, `publicCoordinate`) for channels; only admins get `exactLocation`. The "use my location" button fills in where the witness was standing, often their own home, so publishing it exactly could put them in danger (review M8). The radius filter and `distanceKm` use the rounded point too (`geo.ts: publicCoordinateSql`); otherwise a few radius queries from different centres would triangulate the exact point. Incidents are created at the rounded point of their first upload.

### Opening one item: `GET /market/media/:id`

`UPDATE media SET view_count = view_count + 1 WHERE id = $1 AND status = 'APPROVED' RETURNING *`

This does the access check, the read and the increment in **one atomic statement**. No row back means 404. Then the incident's `view_count` is incremented the same way, since channel interest feeds the trending score. Admin views are not counted, because they are moderation and not market demand.

### Watching a preview

1. **`POST /market/media/:id/preview`** (`stream.controller.ts` → `stream.service.ts: createPreview`):
   - The route allows CHANNEL, ADMIN **and** UPLOADER, so `@ApprovedChannel()` can't be used.
   - Instead, `loadViewer` reads the user's role, channel status and whether it holds the exclusive licence, and `preview-access.ts: decidePreviewAccess` decides:
     - ADMIN: anything.
     - UPLOADER: own media, unless removed.
     - CHANNEL: must be approved (else 403), the media must be APPROVED (else 404), and if it was **sold exclusively to someone else**, previews are closed (410 here, 404 on the file routes). The exclusive buyer paid for the story being theirs alone.
   - Returns 409 if the worker has not produced a preview yet.
   - **A newsroom needs its own marked copy** (`ensureRendition`): if `previews/<id>/v/<userId>/index.m3u8` (or `image.jpg`) is not in storage, it queues a `render-viewer-preview` job (job id per media + viewer, so two tabs share one render) on the separate `preview-render` queue, and polls storage for up to 20 s. If the render is not done by then, it answers **202** `{ kind: 'preparing', retryAfterSec: 3 }` and the player asks again.
   - Signs a **playlist** token `{m, u}` valid 2 minutes. The response is `{ kind: 'hls', playlistUrl: '.../stream/<token>/index.m3u8', expiresAt, watermarkText: 'Preview · Kerala News 24 · 1A2B3C4D · 2026-10-11 14:05 IST' }`.
2. **The player (hls.js) fetches `index.m3u8`.** `StreamService.playlist`:
   - Verifies the token: HMAC, expiry and purpose `stream-playlist`.
   - **Re-checks access against the database** (`authorizeStream`) for the viewer `u` in the token.
   - Reads **that viewer's** playlist and rewrites every URI: the key becomes `../<key token>/key.bin` (purpose `stream-key`, 2 minutes) and each segment `../<file token>/seg_000.ts` (purpose `stream`, 10 minutes).
3. The player resolves those relative URIs against the playlist URL, so it fetches `/stream/<key token>/key.bin` and `/stream/<file token>/seg_000.ts`.
   - Each token opens only its own route: the long-lived segment token cannot fetch the key, so the key is only reachable for 2 minutes after a playlist was served.
   - Segment names must match `^seg_\d{3,5}\.ts$`. That name is the only user-controlled part of a storage key, so this blocks path traversal (`../`).
   - The key is read from `media.hls_key_hex` in the database, never from storage. All renditions of one media share that key.
   - The segments come from the viewer's own rendition (`renditionKey`): a channel always gets `previews/<id>/v/<its id>/`, the owner and admins the generic `previews/<id>/hls/`. Since `u` is inside the signed token, a forwarded link shows the **forwarder's** name.
4. Headers:
   - Playlist and key: `Cache-Control: private, no-store`.
   - Segments: `private, max-age=600` (they are useless without the key).

### Downloading after purchase: `GET /files/download/<token>`

- The buyer's logged-in session asks `GET /orders/:id/download` (orders module) for a link; the web app navigates to it at once (`apps/web/lib/download.ts`).
- `StreamService.download` (review M3):
  - verifies the token (purpose `download`), and refuses it if it was issued more than **2 minutes** ago (the issue time is `exp − DOWNLOAD_TTL_SEC`), so a link is only useful right after the buyer asked for it;
  - if the token names a buyer (`u`), the order must be theirs;
  - joins the order with the media and its verification, and requires `status = 'PAID'` and media not REMOVED;
  - needs the **delivery copy** (review H3, made by the worker; see `docs/learning/media-and-processing.md`). If it is missing, it queues a `prepare-delivery` job and answers 409 "being prepared". The untouched original is never served;
  - rate limit: 20 downloads per order per hour (a Redis counter);
  - **single use**: `SET micky:download-used:<sha256(token)> NX EX …` before the first byte. A second request with the same link gets **410**. A `HEAD` request gets 405, so a link checker cannot use up the link.
- It then streams the delivery copy with `Content-Disposition: attachment; filename="Fire-at-Marine-Drive.mp4"` and `X-Content-SHA256` / `Repr-Digest` with the copy's checksum (also shown on the media page as `purchased.fileSha256`). The name comes from `common/views.ts: downloadFileName`, the one function for both the header and the JSON (review L8): the title reduced to `[A-Za-z0-9-]` plus the extension of the file **we** deliver, so it is header-injection safe.
- `downloadCount` goes up only when every byte of the file went into the response (`stream.controller.ts: meterDownload`). Counting when the link is issued (as before) counted clicks, not downloads.

### Live updates

1. The browser runs `io(API_URL + '/live', { auth: { token: accessToken } })`.
2. `live.gateway.ts: handleConnection`:
   - Verifies the JWT with `JwtService`.
   - Loads the user's role and channel status **from the database**.
   - Approved channels and admins `join('channels')`. Everyone else gets `emit('error', { message })` and `disconnect(true)`.
   - A timer disconnects the socket when the access token expires, so the client must reconnect with a fresh token.
3. When an admin approves media, the admin module calls `RealtimeService.emitToChannels({ type: 'media.approved', ... })`. The service does `namespace.to('channels').emit('media.approved', payloadWithoutType)`.
4. The gateway hands its namespace to the service in `afterInit`. Before that, and in the worker process (no HTTP server), `emitToChannels` just logs and returns, so callers never crash.

## 3. Key concepts, simply

### Filtering and pagination

- **Offset pagination:** `LIMIT pageSize OFFSET (page-1)*pageSize`, plus a separate `COUNT(*)` with the same `WHERE` for `total`.
- **Stable sort:** every sort ends with `id DESC`. Without it, rows with equal timestamps could appear on two pages or on none.
- **Trade-off:** large offsets get slow (Postgres still walks the skipped rows). For infinite scroll at scale you would switch to **keyset (cursor) pagination**: `WHERE (published_at, id) < ($last_published_at, $last_id)`.

### Bounding box + haversine

- "Within 50 km" means a circle on a sphere. The exact test is the **haversine formula** (great-circle distance). It uses trig functions, so the database must compute it for every row, and an index can't help.
- Trick: first filter with a **bounding box**, the rectangle around the circle:
  - Latitude: ±r/111.2 km per degree.
  - Longitude: wider near the poles, `asin(sin(r/R)/cos(lat))`.
  - The box test is plain `BETWEEN` comparisons, which a B-tree index on `(latitude, longitude)` could serve.
  - Only rows inside the box get the expensive exact check.
- Both run in SQL (`geo.ts`), so pagination and `total` stay exact. Filtering in JavaScript after `LIMIT` would give wrong page sizes.
- Edge cases handled:
  - Near the poles or across the ±180° meridian, the longitude range is dropped and only the haversine check is used.
  - `least(1, ...)` stops floating-point noise from making `asin` fail.

### The N+1 query problem and batching

- The naive approach: load 20 media, then for each one query its verification, its order count and the caller's purchase. That is 1 + 20×3 = **61 queries**.
- Batching instead: collect the 20 ids, then run `WHERE media_id IN (...ids)` once per kind of data, and join in memory with a `Map`. That is **5 queries for any page size** (page, count, verifications, paid counts, own purchases), and the last three run in parallel.
- Incident thumbnails use Postgres **`DISTINCT ON (incident_id) ... ORDER BY incident_id, published_at DESC`**: "the newest row per group" in one query.

### Indexes used (defined in `db/schema.ts`)

- `media_status_created_idx (status, created_at)`: the base "approved, newest first" scan.
- `media_incident_idx (incident_id)`: incident detail, thumbnails, and the trending join.
- `orders_media_idx (media_id)`: paid counts and purchases per media.
- `incidents_trend_idx (trend_score)` and `incidents_last_seen_idx (last_seen_at)`: incident sorts and the time window.
- Primary keys: the incident join and single-row lookups.

**Not indexed yet:** there is no `(latitude, longitude)` index and no trigram index for `ILIKE '%q%'`. See section 4.

### HLS and AES-128, simply

- **HLS (HTTP Live Streaming)** cuts a video into small files (`seg_000.ts`, `seg_001.ts`, about 4 s each). A text **playlist** (`index.m3u8`) lists them. The player downloads the playlist, then the segments one by one over plain HTTP. That makes it cache-friendly and able to start fast.
- **AES-128 encryption:** each segment is encrypted with a 16-byte key. The playlist line `#EXT-X-KEY:METHOD=AES-128,URI="key.bin"` tells the player where to fetch the key.
  - We serve the key only through a token-checked route.
  - Copying the segment URLs is useless without a valid, unexpired token for the key.
- **This is not DRM.** A determined user with dev tools can capture the key while the token is valid, and `ffmpeg -i <playlistUrl> -c copy saved.mp4` saves the whole preview in one command (review H4 did exactly that). Encryption raises the effort; it does not make copying impossible. That is why what is *in* the preview matters more (next sections).

### Signed URLs (HMAC)

- `<video>`/hls.js and `<img>` cannot send an `Authorization` header. So the API hands out URLs that carry their own proof: `base64url(payload).base64url(HMAC-SHA256(secret, payload))`.
- The server recomputes the HMAC. Changing even one character of the payload breaks it, and only the server knows the secret.
- The payload holds:
  - the **purpose** (`stream-playlist`/`stream-key`/`stream`/`thumb`/`download`), so a thumbnail token can't open a download and a segment token can't fetch the key;
  - an **expiry**;
  - the ids.
- Signatures are compared with `timingSafeEqual`, so response timing reveals nothing about how many characters matched.
- We **also re-check the database** on every stream request. The token proves "we issued this", the database answers "is it still allowed". So a takedown or a revoked channel takes effect immediately.

### Why screen recording can't be fully prevented, and what we do instead

- Whatever reaches a screen can be filmed: OS screen recorders, capture cards, or a phone pointed at the monitor. A stream can also simply be saved with ffmpeg.
- Even Widevine/FairPlay DRM (paid licence servers) only blocks *software* capture on some platforms.
- So the protection is economic, forensic and legal, not technical:
  - **Little of value reaches the browser:** at most `min(30 s, 40% of the clip)`, so a short clip is never shown whole; 360p with a denser, more opaque mark for clips under 30 s (480p for longer ones); photos at most 640 px.
  - **Accountability in the pixels:** each newsroom's copy has `ORGANISATION · 1A2B3C4D` (its name and the first 8 hex digits of its user id) burned in, tiled in the opposite direction to the generic mark. A saved stream or a screen recording names the leaker; an admin finds the account with `WHERE id::text LIKE '1a2b3c4d%'`. The moving overlay in the player is extra, not the protection: it disappears from a ripped stream.
  - **Exclusive means exclusive:** after an exclusive sale, other newsrooms get no preview at all.
  - The original never leaves before payment, and the terms of service carry penalties.

### Per-newsroom renditions: why render on first view, and what it costs

- **Options:** (a) burn the viewer's name into every segment on every request (too much CPU); (b) a forensic, per-session segment mark (A/B segment variants, invisible watermark), which is strong but needs specialised tooling; (c) **render one marked copy per (media, newsroom) on first view and cache it**. We chose (c): simple, and at Micky's scale (tens of newsrooms) the number of renditions stays small.
- **How it stays cheap:** the worker first makes a private **mezzanine** MP4 per media (already cut to the preview length, scaled down and generically marked). A newsroom's rendition is that mezzanine plus one overlay, encoded with `libx264 -preset superfast -crf 30`, a bitrate cap (800 kbit/s at 360p, 1200 kbit/s at 480p) and `-threads 2`. The large original is never decoded again.
- **Measured on a 2-core machine** (like the 2-OCPU free VM), worst case = a 30 s, 480p preview:
  - synthetic test pattern: 2.5 s wall, 3.9 CPU-seconds, about 3 MB cached;
  - very grainy footage (the hardest to encode): 7.9 s wall, 14.4 CPU-seconds, about 4.7 MB cached;
  - short clips (360p, under 12 s of preview): 0.4–0.5 s wall.
  So 50 newsrooms opening one 30 s clip cost about 2–6 CPU-minutes and 150–250 MB of storage. Renders run on their own queue with concurrency 1 (one FFmpeg next to the upload worker's one), so a newsroom never waits behind an upload, and uploads never wait behind newsrooms.
- **Cache:** a Redis sorted set indexes renditions; a daily job deletes those older than 7 days and all renditions of removed or exclusively sold media. The next view simply renders again.

### WebSockets vs polling

- **Polling:** the dashboard asks "anything new?" every N seconds. It is simple, but wasteful (most answers are "no") and slow (up to N seconds late).
- **WebSocket:** one long-lived two-way connection, so the server pushes the moment something happens.
- **Socket.IO** adds to raw WebSockets:
  - automatic reconnection;
  - fallback to HTTP long-polling when WebSockets are blocked;
  - namespaces (`/live`) and rooms.

### Socket.IO rooms

- A **room** is a named group of sockets on the server. The gateway puts every allowed socket in the room `channels`.
- `namespace.to('channels').emit(...)` reaches all of them. Rejected users never join, so they never receive anything.
- Other uses: you could add per-incident rooms (`incident:<id>`) for "follow this story".

### JWT auth in the handshake

- Browsers can't set headers on a WebSocket upgrade, so the access token goes in Socket.IO's `auth` payload (`handshake.auth.token`).
- It does not go in the URL query string, because URLs end up in proxy and server logs.
- We verify it like the HTTP guard does. Then we **read the role and approval from the database**, because a channel may have been approved or rejected after the token was issued.
- A connection can outlive the 15-minute token, so it is closed at token expiry.

## 4. Trade-offs, and how to scale

| Today | Why | At scale |
|---|---|---|
| Bounding box + haversine in plain SQL | No extension needed, easy to explain | **PostGIS**: `geography` column, GiST index, `ST_DWithin(geog, point, meters)` (index-assisted), `ORDER BY geog <-> point` for nearest (KNN) |
| `ILIKE '%q%'` | Simple, fine for thousands of rows | `pg_trgm` GIN index, or Postgres full-text search (`tsvector`, ranking), or a search engine |
| Offset pagination | Page numbers in the UI | Keyset pagination for deep scrolling |
| API streams every segment from storage | One place for access checks | **CDN with signed cookies or signed URLs** (CloudFront, Cloudflare): the API only signs; the CDN checks the signature at the edge and serves cached segments. Keep the **key** behind the API so revocation still works |
| Token re-checked against the DB on every segment | Instant takedown | Cache the access decision for ~30 s in Redis, or check only on the playlist and key |
| One marked rendition per newsroom, rendered on first view | Simple, cheap at tens of newsrooms (measured above) | Forensic segment watermarking (A/B variants per segment, so each session's sequence is unique) without re-encoding per viewer; or render at upload time for newsrooms that follow a region |
| Coordinates rounded to 3 decimals | Easy to explain and to test | Snap to the geohash-6 cell centre, and let the uploader opt in to share the exact point with buyers |
| Single-use download links in Redis | No schema change needed | A `download_grants` table (nonce, order, buyer, used_at) for an audit trail of every download |
| In-process Socket.IO | One API instance | **`@socket.io/redis-adapter`**: `emit` on any instance is published through Redis to every instance, so all connected clients receive it. Use sticky sessions at the load balancer for the long-polling fallback |
| `view_count` incremented per request | Simple, atomic | Buffer increments in Redis and flush in batches; dedupe per viewer |

## 5. Interview questions with model answers

1. **How do you find all media within 50 km of a point efficiently?**
   Prefilter with a bounding box (`lat BETWEEN ... AND lng BETWEEN ...`), which an index can serve. Then apply the exact haversine distance only to the survivors. Both steps run in SQL, so `LIMIT`/`OFFSET` and the total stay correct. At scale, use PostGIS `ST_DWithin` with a GiST index on a `geography` column.

2. **Why not filter by distance in JavaScript?**
   You'd have to load every candidate row from the database (slow, memory-hungry), and pagination breaks: after `LIMIT 20` you filter some out and return a short page, and `total` is wrong.

3. **What is the N+1 problem and how did you avoid it?**
   One query for a list, then one more query per item for related data. With 20 items and three relations that is 61 round trips. I collect the ids and load each relation once with `WHERE media_id IN (...)`, then join in memory with a `Map`. A page costs 5 queries regardless of size. ORMs' "eager loading" (or DataLoader in GraphQL) does the same thing.

4. **How do you increment a view counter safely under concurrency?**
   `UPDATE media SET view_count = view_count + 1 WHERE id = $1`. The database does the read-modify-write atomically under a row lock. Reading the value in Node, adding 1 and writing it back would lose updates when two requests interleave. My test fires 4 concurrent requests and checks the count is exactly 5.

5. **How does HLS with AES-128 work, and is it DRM?**
   The video is split into segments listed in an `.m3u8` playlist. Each segment is AES-128 encrypted, and the playlist points to a key URL. The player fetches the key and decrypts in the browser. It is not DRM: the key reaches the client in the clear, so anyone can save the stream with ffmpeg while their tokens are valid. Real DRM (Widevine/FairPlay) keeps keys inside a secure module and needs a paid licence server. We make the key URL short-lived (2 minutes, minted when the playlist is served) and bound to the viewer, but the real defence is that the saved copy is short, small and carries the viewer's name in its pixels.

6. **How do your signed URLs work, and what stops someone from forging or reusing them?**
   Token = `base64url(payload) + "." + HMAC-SHA256(secret, payload)`. The payload has a purpose, an expiry and ids. Without the secret you can't produce a valid HMAC for a modified payload. Expiry limits reuse to 10 minutes. The purpose stops a thumbnail token from being used as a download token. I compare with `timingSafeEqual` to avoid timing attacks, and I re-check access in the database on each request so takedowns apply immediately.

7. **Why does the playlist contain different tokens for the key and the segments?**
   The token is a path segment, so the API rewrites the playlist's URIs to `../<key token>/key.bin` and `../<file token>/seg_000.ts`, which resolve next to the playlist. The playlist token lives 2 minutes, the key token 2 minutes, the segment token 10 minutes. Each token's purpose opens only its own route, so the long-lived segment token cannot fetch the key, and all of them carry the viewer's id, which selects that viewer's marked rendition.

8. **How did you prevent path traversal in the segment route?**
   The segment name is the only user-controlled part of the storage key. It must match `^seg_\d{3,5}\.ts$` before anything else runs, so `../`, encoded slashes and other names return 404. The storage layer also rejects keys containing `..` and checks the resolved path stays under the storage root (defence in depth).

9. **Can you stop a news channel from screen-recording the preview?**
   No. Anything displayed can be filmed, and an HLS stream can be saved with one ffmpeg command. So the preview is deliberately not worth stealing and traceable: at most 40% of the clip and never more than 30 s, 360p for short clips, photos at 640 px, and each newsroom's own copy has its name and account code burned into the pixels, so any copy names its source. After an exclusive sale other newsrooms lose the preview entirely. The full file is only served after a PAID order, through a single-use link.

10. **How do you make a download link that cannot be shared?**
    The link is only minted for the buyer's logged-in session, must be used within 2 minutes, and works once: the first request claims the token's hash in Redis with `SET NX` before sending a byte, so a forwarded or replayed link gets 410. A `HEAD` is refused so link previewers don't burn it. `downloadCount` counts files fully sent, not links issued.

11. **Why WebSockets/Socket.IO instead of polling for new footage alerts?**
    Polling wastes requests (most return nothing) and adds latency up to the polling interval. A WebSocket keeps one connection open, so the server pushes instantly. Socket.IO adds reconnection, a long-polling fallback, namespaces and rooms. For one-way server-to-client updates, Server-Sent Events would also work.

12. **How do you authenticate a WebSocket connection?**
    The client sends the JWT in the Socket.IO handshake `auth` payload. On connection the server verifies the signature and expiry, then loads the user's role and approval from the database. Allowed users join the `channels` room; others get an `error` event and are disconnected. The socket is closed when the token expires, which forces a reconnect with a fresh token.

13. **You now run three API instances behind a load balancer. What breaks in realtime, and how do you fix it?**
    `emit` on instance A only reaches sockets connected to A. Use the Socket.IO **Redis adapter**: emits are published over Redis pub/sub and every instance delivers them to its own sockets. If the long-polling transport is enabled, configure sticky sessions so a client's polling requests hit the same instance.

14. **How would you serve previews to thousands of channels without the API streaming every byte?**
    Put the segments behind a CDN and protect them with CDN-signed cookies or URLs (CloudFront signed cookies, Cloudflare tokens), so the edge checks the signature and caches. Keep the small AES key route on the API, where access is checked against the database. That is cheap and still revocable.

15. **Why return 404 instead of 403 for another uploader's media, but 403 for an unapproved channel?**
    A 403 on someone else's resource confirms it exists, which leaks information. An unapproved channel already knows its own status, and a clear "not approved yet" message helps it, so 403 is honest and useful there.

16. **Why does the "trending" sort use a stored `trend_score` instead of computing it in the query?**
    The score (a Hacker-News-style gravity formula over distinct uploaders, uploads, views and age) is computed by the incidents service when things change and on a schedule. Storing it makes sorting a cheap indexed read instead of an aggregate over all media on every request. The trade-off is the score being a few minutes stale.

## 6. Testing

- `apps/api/test/market.e2e-spec.ts` covers:
  - access: 401, uploader 403, pending channel 403;
  - only APPROVED media is listed, and no uploader identity appears;
  - category, type and sinceHours filters;
  - radius and nearest sort;
  - search with literal `%` and `_`;
  - trending sort and pagination;
  - purchase and availability per caller (including the delivery copy's checksum);
  - rounded coordinates for channels in lists, detail, incidents and distances, exact ones for admins and the owner (review M8);
  - atomic view counting;
  - incidents list and detail.
- `apps/api/test/stream.e2e-spec.ts` covers:
  - preview sessions for channel, admin and owner, and denial for everyone else;
  - 202 "preparing" and exactly one queued render on a newsroom's first view;
  - 410 for other newsrooms after an exclusive sale (old links stop too), while the buyer, owner and admins keep it;
  - 409 when there is no preview yet;
  - playlist, segment and key bytes and headers;
  - segment-name and traversal rejection;
  - tampered, expired and wrong-purpose tokens;
  - immediate revocation;
  - thumbnails;
  - PAID-only downloads of the delivery copy (never the original) with a safe file name and its checksum header;
  - no link without the buyer's session, single use (410 on reuse), HEAD refused, links older than 2 minutes refused, another buyer's link refused;
  - `downloadCount` counts completed downloads, not issued links;
  - 409 and a queued job when the delivery copy is missing.
- `apps/api/test/realtime.e2e-spec.ts` starts a real server and speaks the Socket.IO protocol over Node's built-in `WebSocket` (no `socket.io-client` dependency). It covers delivery to approved channels and admins, CORS, and rejection of bad tokens, uploaders, and pending or revoked channels.
- `test/market.fixtures.ts` inserts processed media rows and fake HLS files directly, because uploads and processing are another module. It also creates users directly in the database, to stay under the 10/min register rate limit.
- Unit tests: `src/market/geo.spec.ts` (bounding box contains the circle, LIKE escaping) and `src/stream/stream.spec.ts` (access rules including the exclusive-sale rule, segment regex, IST formatting, safe file names, and `meterDownload`: counted once when every byte went out, even if only `close` fires; not counted when aborted).
