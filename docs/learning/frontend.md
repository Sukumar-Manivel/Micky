# Frontend (the web app)

How the FirstFrame website works: one Next.js app serves three kinds of people (witnesses who upload, newsrooms who license, and admins who moderate). Code lives in `apps/web`. It is a Next.js 16 App Router app written in TypeScript and styled with Tailwind CSS v4. It is installable as a PWA.

## What was built and why

| Area | Routes | Who | Job |
|---|---|---|---|
| **Public** | `/`, `/login`, `/register`, `/report`, `/terms`, `/privacy` | Anyone | Explain the product, sign up, report harmful footage without an account. |
| **Uploader** | `/upload`, `/dashboard`, `/dashboard/media/[id]`, `/dashboard/earnings` | UPLOADER | Upload with a progress bar, follow review status, edit price, withdraw earnings by UPI. |
| **Newsroom** | `/newsroom` (live feed), `/newsroom/map`, `/newsroom/incidents/[id]`, `/newsroom/media/[id]`, `/newsroom/purchases` | Approved CHANNEL (and ADMIN) | Watch incidents trend live, preview watermarked footage, buy a licence, download the original. |
| **Admin** | `/admin`, `/admin/review`, `/admin/channels`, `/admin/payouts`, `/admin/reports` | ADMIN | Approve or reject uploads using the verification signals, approve newsrooms, send payouts, handle complaints. |

The one big design decision is that **the browser talks to the API directly**. Next.js serves the pages; every piece of data comes from the NestJS API (`docs/API.md`) through `fetch` calls made in the browser. There is no "backend for frontend" layer in Next.js. This keeps one source of truth for auth and permissions (the API), and lets the API be scaled, secured and tested on its own.

## Folder structure (App Router)

```
apps/web/
├─ app/                         ← one folder = one URL segment
│  ├─ layout.tsx                  root layout: <html>, header, footer, providers (Server Component)
│  ├─ page.tsx                    "/" landing page (Server Component, zero JS for its content)
│  ├─ manifest.ts                 /manifest.webmanifest for the PWA
│  ├─ runtime-config.js/route.ts  /runtime-config.js: tells the browser where the API is (see Deployment)
│  ├─ error.tsx, not-found.tsx    error boundary and 404 page
│  ├─ login/ register/ report/    public forms: page.tsx (server) + *-form.tsx (client)
│  ├─ terms/ privacy/             static Server Components
│  ├─ upload/                     layout.tsx guards the role, upload-form.tsx does the work
│  ├─ dashboard/                  uploader area; layout.tsx = <RequireRole roles={['UPLOADER']}>
│  │  └─ media/[id]/              dynamic segment: the id comes from the URL
│  ├─ newsroom/                   newsroom area; layout.tsx = <RequireRole roles={['CHANNEL','ADMIN']}>
│  └─ admin/                      admin area; layout.tsx = <RequireRole roles={['ADMIN']}> + section tabs
├─ components/                  shared UI: ui.tsx (Button, Panel, Alert…), badges.tsx,
│                               verification-panel.tsx, preview-player.tsx, require-role.tsx, maps…
└─ lib/                         no React: api.ts (typed client), session.ts, upload.ts,
                                use-api.ts, use-live.ts, types.ts (mirrors API.md), format.ts, money.ts
```

Conventions the App Router gives us:
- `page.tsx` makes a route public; any other file in the folder is private to it (for example `admin/review/review-queue.tsx`).
- `layout.tsx` wraps every page below it and **stays mounted** when you navigate between those pages. That is why the role guard lives in a layout: it runs once per area, not once per page.
- `[id]` is a dynamic segment. Client components read it with `useParams()`.
- `error.tsx` catches render errors below it (in this Next.js version the reset callback is called `retry`). `not-found.tsx` renders for unknown URLs.

## Server Components vs Client Components, page by page

In the App Router every component is a **Server Component** unless its file starts with `'use client'`. Server Components render to HTML on the server and ship **no JavaScript** for themselves. Client Components are also pre-rendered to HTML, but their code is sent to the browser so they can use state, effects, event handlers and browser APIs.

| Page | Type | Why |
|---|---|---|
| `/`, `/terms`, `/privacy`, `not-found` | Server | Pure content. Prerendered at build time (`○ Static` in the build output) and served as plain HTML. |
| Every `page.tsx` | Server | Each one only exports `metadata` (the `<title>`) and renders one client component. `metadata` can only be exported from Server Components. |
| `login-form`, `register-form`, `report-form` | Client | Form state, submit handlers, `useRouter`, `useSearchParams`. |
| Dashboard, upload, newsroom, admin views | Client | They need the **access token**, which only exists in browser memory (see Auth). A Server Component cannot see it, so it could not call the API as the user. |
| `RequireRole`, `SiteHeader`, `AuthProvider`, toasts | Client | They read the session store and react to it. |
| `ui.tsx`, `badges.tsx`, `verification-panel.tsx` | Neither (shared) | No hooks, so they work inside both kinds. |

Two details that come from **Cache Components** (`cacheComponents: true` in `next.config.ts`):
- Anything that reads request-time data (`useSearchParams`, a dynamic `[id]`) must sit inside `<Suspense>`. The static part of the page is prerendered as a shell, and the rest streams in. That is why `newsroom/page.tsx` wraps `<LiveFeed />` in `<Suspense fallback={<PageSkeleton />}>`.
- Next.js checks in development that navigations can show UI instantly. Our role-guarded pages can't: they wait for the browser to restore the session first. So each guarded page and layout sets `export const instant = false`, which tells Next.js this is deliberate.

## Auth in the browser

```
 Page load                      lib/session.ts                       API
 ─────────                      ──────────────                       ───
 AuthProvider mounts ──────────▶ refresh() ──POST /auth/refresh (cookie ff_refresh)──▶
                                  ◀── { accessToken, user } + rotated cookie ──────────┘
                                  state = { user, accessToken (memory only), ready: true }
 Any API call ─▶ api.ts request() ─ Authorization: Bearer <accessToken> ────────────────▶
                  ◀── 401 (token expired after 15 min)
                  session.refresh() ── single-flight: everyone awaits one promise ──────▶
                  retry once with the new token ─────────────────────────────────────────▶
```

**Where each token lives, and why:**
- The **access token** (valid 15 minutes) lives in a JavaScript variable inside `createSessionStore` (`lib/session.ts`), never in `localStorage`. An XSS bug could read `localStorage` at any later time; a variable disappears with the tab.
- The **refresh token** (valid 7 days) is an **httpOnly cookie** set by the API, with path `/api/v1/auth`. JavaScript can't read it at all. The browser attaches it only to `/auth/*` requests made with `credentials: 'include'`.
- On every page load, `AuthProvider` calls `session.refresh()` to swap the cookie for a fresh access token. Until that finishes, `ready` is `false` and guarded pages show a skeleton.

**Single-flight refresh.** The API *rotates* the refresh token on every use and treats reuse of an old one as theft, revoking every session of that user. If five requests got a 401 at once and each refreshed, four would send an already-used cookie and log the user out. So `refresh()` keeps the in-flight promise in `inFlight`: the first caller starts it, everyone else awaits the same promise, and it is cleared in `finally`. `lib/session.test.ts` checks that three parallel calls produce one refresh request.

**Across tabs.** Two tabs share one cookie, so two tabs refreshing at the same instant has the same problem. `withCrossTabLock` uses the Web Locks API (`navigator.locks.request('firstframe-refresh', …)`), so the second tab waits and then sends the new cookie.

**React integration.** `AuthProvider` exposes the store with `useSyncExternalStore`, React's built-in way to subscribe to state that lives outside React, without "tearing" (two components seeing different values in one render).

**Typed API client (`lib/api.ts`).** One function per endpoint in `API.md` (`adminApi.approve`, `marketApi.media`, …), all going through `request()`. That function adds the bearer header, retries once after a refresh on 401, and turns NestJS error bodies (`message` as a string or an array) into an `ApiError` with readable text. `describeError` maps a `TypeError` from `fetch` (offline or CORS) to "Could not reach FirstFrame". The response types in `lib/types.ts` mirror `API.md` exactly.

## Role guards

`components/require-role.tsx` wraps each area's layout:

1. While the session is loading: show a skeleton.
2. No user: `router.replace('/login?next=<current path>')`. After login, `safeNext()` only accepts same-site paths (`/x`, not `//evil.com`), so the parameter can't become an open redirect.
3. Wrong role: send the user to their own home (`homeFor`: ADMIN → `/admin`, CHANNEL → `/newsroom`, UPLOADER → `/dashboard`).
4. A CHANNEL whose organisation is not yet approved sees an "awaiting approval" page instead of the marketplace.

**This is a convenience, not security.** Anyone can edit JavaScript in their own browser. The real checks are on the API: `@Roles('ADMIN')` on every admin route, `@ApprovedChannel()` on the marketplace, and ownership checks that return 404. A user who bypasses the guard just gets 403s. Role arrays live in `lib/roles.ts` as constants, so they are the same object on every render and don't re-trigger the guard's effect.

## Data loading: `useApi`

`lib/use-api.ts` is a ~60-line hook: `useApi(key, fetcher)` returns `{ data, error, loading, refreshing, reload, setData }`.
- **`key`** identifies the request (for example `admin/review-queue?page=2&risk=HIGH`). A new key starts a new fetch. A response for an old key is ignored, which avoids the classic race where a slow page-1 response overwrites page 2.
- **`reload()`** refetches while keeping the current data on screen. Polling and live updates use this, so there is no skeleton flash.
- **`setData()`** updates the data locally, for example removing an item from the review queue the moment it is approved (an optimistic update) before the background reload.
- `useEffectEvent` lets the effect call the latest `fetcher` without listing it as a dependency, so passing an inline arrow function doesn't cause a fetch on every render.

Every list follows the same four states: **loading** (skeletons with `aria-busy`), **error** (an `Alert`, with a retry button on admin lists), **empty** (an `EmptyState` that says what to do next), and **data**. Detail pages that fail to load show `LoadFailed` (a heading, the reason, and a link back).

SWR or TanStack Query would add caching between pages and deduplication. We chose a small hook the student can explain line by line. The trade-off is that going back to a page refetches it.

## Upload progress with XHR

`fetch()` cannot report **upload** progress in browsers today. `XMLHttpRequest` can, through `xhr.upload.onprogress`. So `lib/upload.ts` uses XHR for the one big upload and `fetch` for everything else:

- The body is a `FormData` with the text fields first and `file` **last**, so the API can reject bad fields before the large file has streamed in. The `Content-Type` header is not set by hand, because the browser must add the multipart boundary itself.
- `onProgress(loaded / total)` drives a native `<progress>` element. Before sending, the form checks file size and type (500 MB video, 25 MB photo) and the recording time (not in the future, no older than 30 days). The API checks all of this again, and checks the real file type from its magic bytes.
- If the token expires during a long upload on a slow phone network, a 401 triggers the shared single-flight refresh and the file is sent once more.
- `abort()` cancels it, and the form cancels automatically if the user leaves the page.
- Status codes become plain sentences: 413 "too big", 415 "type not supported", 409 "already uploaded".

## Live updates with Socket.IO

`lib/use-live.ts` connects to the API's `/live` namespace. The server pushes `media.approved` and `incident.updated` to approved newsrooms and admins.

- `auth` is a **callback** (`cb({ token: session.getToken() })`), so each reconnect sends the *current* token, not the one from 20 minutes ago.
- If the server rejects the socket (an `error` event, usually an expired token), we refresh the session and reconnect, at most twice.
- Socket.IO uses WebSockets and falls back to HTTP long-polling on networks that block them, and it reconnects on its own. `LiveIndicator` shows "Live", "Connecting" or "Offline, retrying" in a `role="status"` region.
- On an event the feed shows a toast (an ARIA live region, so screen readers announce it) and calls `reload()`. The event carries ids, not full data, so the page refetches through the normal permission-checked API.
- `socket.io-client` is loaded with a dynamic `import()`, so it is only downloaded on pages that use live updates.

## Maps with Leaflet

Leaflet touches `window` as soon as it is imported, so it cannot run on the server. `components/maps.tsx` loads it with `next/dynamic(..., { ssr: false })` and shows a skeleton while it loads. This also keeps Leaflet's roughly 40 kB out of pages without a map.
- `LocationPicker` (upload form): a draggable pin, or tap anywhere to move it. "Use my location" calls the Geolocation API. Chennai is only the starting point until the user picks a spot.
- `PointsMap` (incident map, incident page, admin review): pins with popups, and `FitBounds` zooms to show all of them. The `points` array is memoised (`useMemo`), otherwise the map would re-fit its view on every render.
- The pins are CSS `divIcon`s instead of Leaflet's default image markers, which bundlers don't copy. That also lets them use our theme colours.
- Tiles come from OpenStreetMap, with the required attribution.

## Preview protection, and its honest limits

What the newsroom's browser gets before paying, from `POST /market/media/:id/preview`:
- **Video:** a signed HLS playlist (480p, at most 30 seconds, AES-128-encrypted segments). The URLs expire after 10 minutes. The player (`components/preview-player.tsx`) plays it with hls.js, or natively on Safari.
- **Photo:** a signed URL to a watermarked, low-resolution JPEG.
- `watermarkText`, such as "Preview · News TN · 11 Oct".

What the player does:
1. It draws the watermark over the picture and **moves it** around the frame (`.watermark-drift`), so it can't simply be cropped out, plus a fixed corner copy. Any screen recording carries the viewer's organisation name.
2. `controlsList="nodownload noremoteplayback"`, `disablePictureInPicture` and `disableRemotePlayback` remove the browser's "Download" button, picture-in-picture and casting.
3. `onContextMenu` and `onDragStart` call `preventDefault()`, which blocks right-click / long-press "Save video as…" and dragging the image out.
4. It refreshes the session about 45 seconds before the URLs expire, or when a segment request returns 401/403/410, and resumes from the same playhead.
5. The caption says so in plain words: the preview is watermarked and reduced, saving is switched off, and **no website can stop a screen recording**. That is why the name is on it.

**The honest limits.** Everything in the browser is under the user's control. They can open DevTools, read the playlist and key URLs, and download the segments while the token is valid. The AES key is fetched by the browser too, so the encryption stops casual "save segment" grabbing, not a determined person. This is friction, not DRM. Real DRM (Widevine, FairPlay) needs licence servers and costs money, and it still doesn't stop a camera pointed at the screen. The real protection is economic and legal:
- **What leaks is worth little:** low resolution, at most 30 seconds, watermarked with the leaker's name.
- **The original never leaves the server before payment.** `/files/download/:token` only works with a token from `/orders/:id/download`, which requires a PAID order.
- Only hand-approved newsrooms can see previews at all, and the terms forbid recording them.

## The admin screens

- **Review queue** (`/admin/review`): uploads in `IN_REVIEW`, oldest first, filterable by risk. On a wide screen it is a list plus a detail panel. On a phone you see either the list or one upload, with "Back to the queue". The detail shows the watermarked preview, `VerificationPanel` with the full metadata (admins only), the uploader, the time gap between recording and upload, and the stated location on a map. Rejecting needs a reason (3–500 characters, checked before sending), which the uploader sees. After a decision the item is removed locally and the next one opens. A 409 means another admin decided first, so the queue reloads.
- **Newsrooms** (`/admin/channels`): approve, reject, revoke or re-approve. A hint compares the email domain with the website (`lib/domain.ts`). `desk@newstn.in` on `newstn.in` is a match; a Gmail address for a TV channel is worth a closer look.
- **Payouts** (`/admin/payouts`): copy the UPI ID, pay it from the bank app, then record the UTR. Rejecting returns the money to the uploader's balance (the API writes the reversal).
- **Reports** (`/admin/reports`): oldest first, with days left against the 7-day grievance deadline from `docs/RESEARCH.md`. Resolving can also take the footage down.

All of them reuse `ReasonForm` (an inline textarea with length checks, busy and error states), `StatusFilter` (toggle buttons with `aria-pressed`) and the shared badges, so a status always looks the same everywhere.

## PWA basics

A Progressive Web App is a website the phone can "install": an icon on the home screen, opening full-screen without the browser bar.
- `app/manifest.ts` generates `/manifest.webmanifest`: `name`, `id`, `start_url: '/upload'` (witnesses should reach the upload form in seconds), `display: 'standalone'`, theme colours, and icons: 192 and 512 px PNGs, a **maskable** 512 px icon whose content sits inside the safe circle so Android can crop it to any shape, and an SVG. `app/apple-icon.png` covers iOS.
- **There is deliberately no service worker caching API data.** A cached price or "available" flag would be wrong, and a stale review queue is worse than an error. Offline support for the upload form (queue the file, send it later with Background Sync) is the obvious next step.

## Deployment

- `output: 'standalone'` makes `next build` write `.next/standalone/server.js` plus only the `node_modules` it needs. Copy `public/` and `.next/static/` next to it, then run `node server.js`. The Docker image doesn't need the full `node_modules`.
- **The API address at runtime.** `NEXT_PUBLIC_*` variables are inlined into the JavaScript at build time, so one image could only ever talk to one API. Instead, `/runtime-config.js` is a dynamic route (`await connection()` stops it being prerendered) that reads `PUBLIC_API_URL` from the container's environment and returns `window.__FIRSTFRAME_CONFIG__ = {"apiUrl": …}`. The root layout loads it with a plain blocking `<script>` in `<head>`, so it has run before any app code. `lib/config.ts` reads it on each call: the runtime value first, then `NEXT_PUBLIC_API_URL`, then `http://localhost:4000`. The value is validated as an `http(s)` URL, and `<` is escaped so it can't break out of the script. All variables are documented in `apps/web/.env.example`.
- `next.config.ts` adds security headers: `X-Frame-Options: DENY` (no clickjacking on "Buy licence"), `nosniff`, `Referrer-Policy`, and a `Permissions-Policy` that only allows geolocation.

## Performance choices

- Static pages are prerendered. The landing page ships no JavaScript for its content.
- Heavy libraries load only where they're used: hls.js (~150 kB) inside the player, Leaflet with `next/dynamic`, socket.io-client with `import()`.
- Fonts are self-hosted WOFF2 with `unicode-range`, so the extended file (which contains ₹) only downloads when a page uses it, and `font-display: swap` avoids invisible text.
- Signed, expiring thumbnails use a plain `<img loading="lazy">` instead of `next/image`, which would proxy and cache URLs that are meant to expire. The API sends `Cache-Control: private, max-age=3600`, so the browser caches them.
- Reloads keep data on screen. Polling (every 10 s while an upload is PROCESSING) and live events only refetch what changed.

## Accessibility choices

- Tap targets are at least 44 px (`min-h-11`). There is one strong focus ring for every element (`:focus-visible` outline) and a "Skip to content" link.
- Every input has a `<label>` (the click-through test checks for unlabeled controls on every page). Hints and errors are linked with `aria-describedby` and `aria-invalid`.
- Status is never shown by colour alone: badges have text, and verification signals have an icon plus a screen-reader label ("Warning: …").
- `role="alert"` for errors, `role="status"` / `aria-live` for toasts, live status and progress. `aria-busy` on loading regions. `aria-current` on the active admin tab and the selected queue item. `aria-pressed` on filter toggles.
- The AI score is a `role="meter"` with a caption that it is "a signal, not a verdict".
- `prefers-reduced-motion` stops blinking and skeleton pulsing and slows the watermark (it still shows). Colours come from CSS variables with a full dark-mode set. The font is Atkinson Hyperlegible, designed for low-vision readers.
- Layout is tested at 360 px wide: wide tables scroll inside their own box and long emails or UPI IDs wrap (`overflow-wrap:anywhere`), so the page itself never scrolls sideways.

## Trade-offs and known limits

- **The client-side guard means a skeleton first.** Guarded pages render on the server as a skeleton, then fill in after the refresh call. Moving the session to a cookie readable by the Next.js server would allow server rendering, but it would put the access token where every request carries it.
- **No cross-page cache** (see `useApi`). Fine at this scale.
- **Preview protection is friction**, as explained above.
- **No offline upload queue** yet.
- **Admin review has no "get one item" endpoint.** It works from the paginated queue, so a deep link to a single review item isn't possible yet.

## How it was tested

- Unit tests (Vitest): money parsing and formatting, the single-flight session store, the runtime config, the API client helpers and the domain-match hint (`npm test`, 22 tests).
- `npm run build`, `npm run typecheck` and `npm run lint` are all clean.
- A Playwright click-through against the real API (Postgres, Redis, mock payments) at 360 px and 1366 px. It covers: register, log in, the role-guard redirects, admin approve and reject (including the empty-reason validation), newsroom approval, a mock purchase and download link, UPI setup, a payout request then "mark paid", and a public report then "resolve". It also checks every page for sideways overflow, unlabeled inputs and console errors. Screenshots are in `docs/screenshots/`.

## Interview questions with model answers

**1. Why keep the access token in memory instead of localStorage?**
Anything in `localStorage` can be read by any script on the page, including one injected through an XSS bug, at any later time. A variable in a module is gone when the tab closes and isn't sitting in storage waiting. We pair it with a short lifetime (15 minutes) and an httpOnly refresh cookie that JavaScript can't read. The cost is a refresh call on every page load.

**2. What is a single-flight refresh, and what breaks without it?**
When several requests get a 401 at once, only the first starts `POST /auth/refresh`; the others await the same promise. Our API rotates refresh tokens and treats a reused one as theft, revoking all sessions. Without single-flight, parallel refreshes would send the same cookie several times and log the user out. Web Locks extend the same idea across tabs.

**3. If role checks happen in the browser, can't a user just remove them?**
Yes, and that's fine. `RequireRole` exists for user experience: redirecting to login, or showing "awaiting approval". Security is on the API: role guards on every route, ownership checks returning 404, approved-channel checks. Bypassing the client guard only shows an empty page full of 403 errors.

**4. Why are most pages Client Components? Isn't server rendering better?**
The data is per-user and needs the access token, which only exists in the browser. Server Components can't call the API as that user. So `page.tsx` stays a Server Component (for `metadata` and the static shell) and renders one client component that loads the data. Truly static pages (landing, terms, privacy, 404) are pure Server Components with no JavaScript for their content.

**5. Why use XMLHttpRequest for uploads when everything else uses fetch?**
`fetch` has no upload progress events in browsers today. `xhr.upload.onprogress` does, and a progress bar matters on a slow phone network with a 200 MB video. We wrap XHR in a promise, let the browser set the multipart boundary, put the file last in the form, and reuse the shared refresh on a 401.

**6. How do live updates stay authenticated when tokens expire every 15 minutes?**
Socket.IO's `auth` option is a callback that returns the current token on every connect and reconnect. If the server rejects the socket, we refresh the session and reconnect. Events only carry ids, and the page refetches through the normal API, so permissions are always checked by the same code.

**7. Why does Leaflet need `next/dynamic` with `ssr: false`?**
Leaflet reads `window` when it's imported, and `window` doesn't exist during server rendering, so the import would crash. Dynamic import with `ssr: false` loads it only in the browser, shows a skeleton meanwhile, and keeps it out of the bundle for pages without maps.

**8. Can a newsroom download a preview without paying? Be honest.**
A determined one can capture what reaches its browser: screen-record it, or fetch the HLS segments and key with DevTools while the token is valid. We remove the easy paths (download button, right-click, drag, picture-in-picture) and say so honestly in the UI. The real protection is that the preview is only 480p, at most 30 seconds, and watermarked with the viewer's organisation name, while the original file is only reachable through a download token issued for a PAID order. Real DRM would add cost and still lose to a camera.

**9. Why is the watermark drawn by the player and also moving?**
A fixed watermark in a corner can be cropped or blurred out of a recording. A moving one crosses the whole picture over time. Putting the viewer's own organisation name on it turns a leak into evidence of who leaked it, which is a strong deterrent. (The server also burns a watermark into thumbnails and photo previews.)

**10. How did you make one Docker image work for staging and production?**
`NEXT_PUBLIC_*` values are frozen at build time. We added a dynamic route, `/runtime-config.js`, that reads `PUBLIC_API_URL` when the request arrives and sets `window.__FIRSTFRAME_CONFIG__`. The root layout loads it before the app's code, and `apiUrl()` reads it on every call, falling back to the build-time value. With `output: 'standalone'`, the image only contains `server.js` and the files it actually needs.

**11. How do you avoid a stale response overwriting newer data?**
`useApi` tags each response with the request key it belongs to and ignores it if the key has changed (the effect's cleanup sets `cancelled`). Without that, quickly switching from page 1 to page 2 could show page 1's results under a "Page 2" label if the first response arrived last.

**12. Two admins open the same upload. One approves it. What does the other see?**
Their approve or reject call returns 409, because the API only changes `IN_REVIEW` media, in one conditional UPDATE. The form shows the API's message and the queue reloads, so the item disappears. No double decision is possible, because the API's conditional update is the source of truth, not the UI.

**13. What makes the app usable on a 360 px phone?**
It is designed mobile-first with Tailwind breakpoints (`sm:`, `lg:`). Tap targets are 44 px. Wide tables scroll inside their own container, long strings wrap with `overflow-wrap:anywhere`, the admin tabs scroll sideways inside themselves, and the review screen shows one panel at a time. We verified it with a Playwright check that `scrollWidth <= clientWidth` on every page at 360 px.

**14. Why is there no service worker caching in this PWA?**
Our data is about money and availability: prices, "exclusive still available", review queues. Showing a cached version would be wrong, not just old. The manifest alone gives installability. A service worker would be added for one specific job, such as queuing uploads offline, and not to cache API responses.

**15. How do you make status colours accessible?**
Colour is never the only signal. Every badge has a text label, signals have an icon and a screen-reader prefix ("Warning: …"), and the AI score is a labelled `meter` with its percentage shown. The palette is defined as CSS variables with separate light and dark values.
