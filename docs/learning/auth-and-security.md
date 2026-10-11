# Authentication and web security, explained

How Micky logs people in, keeps them logged in, and stops the common attacks on that, plus the browser-side defences (redirects, Content-Security-Policy). It covers the fixes for review findings M1, M2, L1, L2, L10 and I3 in `docs/REVIEW.md`.

## What was built and why

| Piece | Where | Why |
|---|---|---|
| Short-lived **access token** (JWT, 15 min) | `auth.service.ts` `issueTokens`, checked by `common/auth.guards.ts` | Sent on every API call. Short life limits the damage if one leaks. Kept only in the page's memory. |
| Long-lived **refresh token** (random, 7 days idle) | `refresh_tokens` table (SHA-256 hash only), `ff_refresh` httpOnly cookie | Gets a new access token without retyping the password. JavaScript can't read it, so an XSS bug can't steal it. |
| **Rotation with reuse detection** | `AuthService.refresh` | Every refresh replaces the token. Using an old one again means it was copied, so every session of that user ends. |
| **Atomic rotation** (M1) | one conditional `UPDATE … RETURNING` in a transaction | Two parallel refreshes with the same token used to both succeed, giving a thief a session that never tripped reuse detection. |
| **Absolute session lifetime** (M1) | `SESSION_MAX_DAYS` (30) | Rotation used to extend a session forever. Now every session ends 30 days after the password was typed. |
| **Rate limits in Redis** (L2) | `auth/rate-limit/redis-throttler.storage.ts` | Limits per IP used to live in each process's memory: two API containers meant double the limit, and every deploy reset them. |
| **Per-account login backoff** (L2) | `auth/rate-limit/login-backoff.service.ts` | Per-IP limits don't stop a botnet trying a few passwords each from thousands of IPs against one account. |
| **Safe `?next=` redirect** (M2) | `apps/web/app/login/safe-next.ts` | `/\evil.example` passed the old "starts with `/`" check and sent users to a phishing page after a real login. |
| **Content-Security-Policy** (L10) | `apps/web/lib/csp.ts`, `apps/web/proxy.ts`, `infra/Caddyfile` | A safety net: even if an XSS bug appears, the browser refuses scripts and connections from anywhere we didn't list. |
| **72-byte password cap** (I3) | `auth.dto.ts` `MaxBytes` | bcrypt silently ignores everything after 72 bytes. |
| **One email rule** | `isAccountEmail` in `auth.dto.ts`, used by `db/seed.ts` | The seed used to accept an admin email (`admin@x.e2e`) that the login form then rejected. |

## How a request flows

**Login** (`POST /api/v1/auth/login`):
1. `ThrottlerGuard` (global, `app.module.ts`) counts the request in Redis under the client IP: 10 per minute for this route.
2. `ValidationPipe` checks `LoginDto` and lower-cases the email.
3. `AuthService.login`:
   1. `LoginBackoffService.assertAllowed(email)`: if the email is locked, it answers 429 with `Retry-After`, **without checking the password**.
   2. It compares the password with bcrypt. An unknown email is compared against a dummy hash, so both cases take the same time.
   3. On failure it calls `recordFailure(email)`, the same for unknown emails, and answers 401 "Incorrect email or password".
   4. On success it calls `recordSuccess`, then `issueTokens(db, userId, sessionStartedAt = now)`.
4. `AuthController.respond` sets the `ff_refresh` cookie (httpOnly, SameSite=Lax, Secure in production, path `/api/v1/auth`) and returns `{ accessToken, user }`.

**Refresh** (`POST /api/v1/auth/refresh`), when an access token expires:
```
BEGIN
  UPDATE refresh_tokens SET revoked_at = now()
   WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
   RETURNING id, user_id, created_at;                   -- 1 row = we own this token now
  INSERT INTO refresh_tokens (..., created_at = <old created_at>, expires_at = min(now()+7d, created_at+30d))
  UPDATE refresh_tokens SET replaced_by_id = <new id> WHERE id = <old id>
COMMIT
```
If the `UPDATE` returns no row, the service looks the token up:
- unknown → 401;
- expired → 401;
- already revoked → **reuse**: revoke every session of that user, then 401.

**Every other request:** `JwtAuthGuard` verifies the bearer token (HS256 only, the algorithm is pinned), then `RolesGuard` applies `@Roles` and `@ApprovedChannel`.

## Key concepts

### Why the old rotation could be raced

The old code did three separate steps: read the row and check `revoked_at`, insert a new token, then mark the old one revoked. Two requests arriving together both read "not revoked", so both got new tokens.

The fix makes the **check and the claim one statement**. Postgres takes a row lock for the `UPDATE`. The second request waits on that lock. When the first commits, Postgres re-evaluates the `WHERE` for the waiting request, sees `revoked_at` is now set, and returns zero rows. Exactly one request wins, and the loser is handled as reuse, which revokes the winner's new token too.

That is deliberate: if a thief and the real user race, both are logged out and the user logs in again with the password, which the thief doesn't have. The web app's single-flight refresh (`lib/session.ts`, with a cross-tab lock) makes sure our own client never races itself.

The e2e test fires two (and six) parallel refreshes with the same cookie. It expects exactly one 200 and then zero live tokens.

### Absolute lifetime without a new column

The refresh token row's `created_at` means "when this **login session** started". A rotated token copies it from the one it replaces instead of using `now()`. The new token's expiry is `min(now + 7 days, created_at + 30 days)`, so no amount of refreshing passes day 30. This needed no schema change. A clearer name (`session_started_at`) or a `family_id` column would be a nice follow-up migration.

### Two kinds of brute-force limit

| Limit | Key | Stops | Doesn't stop |
|---|---|---|---|
| Per-IP throttle (10 logins/min, 10 registrations/min and 30/hour) | client IP | one machine guessing fast | a botnet: thousands of IPs, a few guesses each |
| Per-account backoff | SHA-256 of the email | many guesses at one account from anywhere | slow guessing across many accounts (password spraying), which needs breached-password checks or 2FA |

**Backoff numbers:**
- The first 5 failures in an hour are free (typos).
- After that, each failure locks the email for 30 s, then 60 s, 120 s, and so on, capped at 15 minutes.
- During a lock the password isn't checked, so guessing during it teaches nothing.
- A successful login clears the count.
- Unknown emails get exactly the same behaviour, so a 429 never reveals that an account exists.

**Trade-off:** anyone can delay a known user's login by failing on purpose. That is why it's a capped *backoff*, not a permanent lockout. An admin can clear it by deleting the `ff:rl:login:*` keys.

Both limits live in **Redis**, shared by every API process and surviving restarts. If Redis is down they **fail open**: requests are allowed and an error is logged. Locking everyone out because a cache blinked would be a worse outage.

**Which IP?** Behind Caddy, `req.ip` must come from `X-Forwarded-For`. Express trusts exactly `TRUST_PROXY_HOPS` proxies (1 in production).
- Trust too many, and clients can fake their IP to dodge limits.
- Trust too few, and everyone looks like Caddy and shares one limit.
- This is why the API domain must stay "DNS only" in Cloudflare.

### Account enumeration on registration (L1): the trade-off

Login doesn't reveal whether an email has an account (same message, same timing). Registration does: "An account with this email already exists" (409). The real fix is a **"check your inbox"** flow:
1. Registration always answers 202.
2. The email gets either a confirmation link or a "you already have an account" note.

That needs email sending, which Micky doesn't have yet.

Options we considered:
- **Pretend success (201) for an existing email:** we would have to either log them in to someone else's account (impossible) or return a fake session that fails later, which is confusing and breaks the double-submit case.
- **Keep 409, slow down mass checks (chosen):** per-IP limits of 10 per minute and **30 per hour**, shared in Redis. Checking one known email is still possible; checking a list of thousands isn't practical.

When email arrives (Brevo or Resend free tiers send 100–300 a day), switch to the 202 flow. For witnesses this matters: knowing someone has an account on an eyewitness platform can itself be sensitive.

### Open redirects (M2)

After login the app goes to `?next=`. The old check was "starts with `/`, not `//`". Browsers are generous about URLs:
- `\` counts as `/`, so `/\evil.example` is the protocol-relative `//evil.example`;
- tabs and newlines are deleted, so `/<TAB>/evil.example` becomes `//evil.example`;
- dot segments collapse, so `/..//evil.example` resolves to the path `//evil.example`.

The fix is: **don't pattern-match URLs, parse them.**
1. Reject control characters and backslashes.
2. Require a leading `/`.
3. Resolve with `new URL(next, location.origin)`.
4. Require the same origin.
5. Check the *normalised* result again, because `/..//evil` is only caught there.

Unit tests cover the reviewer's payloads. A browser test confirmed that every payload lands back on our own origin after a real login.

### Content-Security-Policy (L10)

The CSP is a response header listing where a page may load things from. Micky's:

```
default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com;
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: <API> https://tile.openstreetmap.org https://*.razorpay.com;
media-src 'self' blob: <API>; worker-src 'self' blob:; connect-src 'self' <API> <API as wss://> https://*.razorpay.com;
frame-src https://api.razorpay.com https://checkout.razorpay.com; frame-ancestors 'none';
object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests
```

- **Why it's built per request (`proxy.ts`):**
  - The API's address is only known when the container starts (`PUBLIC_API_URL`, the same value `/runtime-config.js` serves).
  - `next.config.ts` headers are frozen at build time, so they can't carry it.
  - Caddy adds the same policy as a fallback (`header ?Content-Security-Policy`), in case a response arrives without one.
- **Why `'unsafe-inline'` for scripts:** Next.js streams page data as inline `<script>` tags. Nonces would remove that need, but they force every page to render per request and don't work with Partial Prerendering, which this app uses. The CSP still blocks every *external* script host but Razorpay, and every connection but our API and Razorpay. It also blocks framing, plugins and `<base>` hijacking. That is most of the value.
- **Why the blob: sources:** hls.js plays the encrypted preview through MediaSource (a `blob:` URL) and runs its demuxer in a `blob:` worker.
- **Safe rollout:** `CSP_REPORT_ONLY=1` sends the policy as `Content-Security-Policy-Report-Only`, which logs violations without blocking.
- **Verified in a real browser:** Playwright crawled every page as anonymous, witness, newsroom and admin with zero violations. That included Razorpay checkout's script, iframe and telemetry, and the OSM tiles. Injecting a script and a `fetch` from another host was blocked, as it should be.

### Other details

- **bcrypt's 72-byte limit:** "correct horse … (80 characters)" and the same first 72 bytes are the same password to bcrypt. Registration now refuses passwords over 72 **bytes** (a Tamil letter is 3 bytes in UTF-8). Login still accepts up to 128, so older accounts keep working; bcrypt compares only 72 bytes either way.
- **Pinned JWT algorithm:** `verifyAsync(..., { algorithms: ['HS256'] })`. The token never gets to choose how it is checked (the classic `alg: none` and RS/HS confusion attacks).
- **Secrets per process (L3):**
  - In production the API needs the JWT and signing secrets.
  - The worker needs only `INTERNAL_TOKEN`.
  - `AppConfig` checks only what its `APP_ROLE` needs, and gives any secret it doesn't need a random value, never a guessable default.
- **Local dev token:** both `.env.example` files share the dev value `INTERNAL_TOKEN=dev-only-internal-token-change-me-0123456789`, as `docker-compose.yml` does. If the API and verifier tokens differ, every verifier call gets 401 and uploads are published without AI or C2PA results.

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Reuse of any rotated token revokes all sessions | A stolen-and-raced cookie can't survive | A buggy client that refreshes twice logs its user out (our client is single-flight) |
| `created_at` doubles as session start | No migration needed | Column name is less obvious; a `session_started_at` rename would be clearer |
| Backoff keyed by email | Stops distributed guessing on one account | Anyone can delay a known user's login by up to 15 min |
| Rate limits fail open when Redis is down | No lockout from an infrastructure blip | No brute-force protection during the outage |
| 409 on duplicate registration | Clear UX without email | Targeted "is X registered?" checks remain possible |
| `'unsafe-inline'` scripts in the CSP | Keeps static and partially prerendered pages | Weaker against inline-script injection than a nonce CSP |

## Interview questions with model answers

**1. Why two tokens instead of one?**
The access token is sent with every request, so it's the one most likely to leak (logs, a proxy, an XSS bug reading memory). It lives 15 minutes and is never stored. The refresh token can mint new access tokens, so it's more valuable. It lives in an httpOnly cookie that JavaScript can't read, is scoped to the auth path, and is only sent to one endpoint. Short exposure for the frequently used credential, strong storage for the powerful one.

**2. What is refresh-token rotation, and how does reuse detection work?**
Each refresh returns a new token and invalidates the old one. A legitimate client only ever holds the newest token. If an old token shows up again, two parties have it, and we can't tell which is the thief, so we revoke every session for that user and make them log in with the password.

**3. You found a race in rotation. Explain it and the fix.**
Read, check, then write in separate statements: two parallel requests both read "not revoked" and both succeeded, so a thief racing the real client got a session that never triggered reuse detection. The fix is a single conditional `UPDATE … WHERE revoked_at IS NULL … RETURNING` inside a transaction that also inserts the replacement. The database's row lock serialises the two. The second re-checks the condition after the first commits, gets no row, and is treated as reuse. We proved it with a test that fires parallel refreshes and expects exactly one 200.

**4. Why does a session need an absolute lifetime if refresh tokens expire after 7 days?**
Because rotation extends the deadline each time: a client that refreshes daily stays logged in forever, and so does a thief who keeps a stolen session warm. An absolute limit (30 days from the password) bounds the damage of any stolen session and forces periodic re-authentication.

**5. How do you rate-limit logins properly?**
In layers:
- per IP, to stop one machine going fast;
- per account with exponential backoff, to stop many machines targeting one account;
- in shared storage (Redis), so the limits hold across processes and restarts.

Make the per-account rule identical for unknown emails, so it doesn't leak which accounts exist, and cap it, so it can't become a lockout attack. For password spraying across accounts you need more: breached-password checks, 2FA, anomaly alerts.

**6. What is account enumeration and how did you handle it on registration?**
Learning whether an email has an account from how the server answers. Login is safe: same message and timing either way. Registration can only hide it with an email-confirmation flow, which we don't have yet, so we kept the 409 and rate-limited registration per IP (10/min, 30/hour, in Redis). That stops bulk checks, while a single targeted check remains possible. It's a documented, accepted risk with a clear upgrade path.

**7. What's an open redirect and why is it dangerous after login?**
A parameter that sends the user to any URL. After a real login on the real site, users trust whatever comes next, so landing on a look-alike "session expired, sign in again" page harvests passwords. The robust check is to parse the URL with the same parser the browser uses, require the same origin, and re-check the normalised path, rather than string-matching, which `/\evil.example` defeats.

**8. What does a Content-Security-Policy protect against, and what were your constraints?**
It limits where scripts, styles, images, frames and connections may come from, so injected code can't load an attacker's script or send data to their server. `frame-ancestors 'none'` stops clickjacking. Our constraints:
- the API origin is only known at runtime, so the header is built per request in the Next.js proxy;
- Next's inline streaming scripts need `'unsafe-inline'` unless we give up static rendering;
- hls.js needs `blob:` for media and workers;
- Razorpay needs its script host and iframe.

We verified in a real browser that every page loads with no violations and that a foreign script is blocked.

**9. Why cap passwords at 72 bytes?**
bcrypt only uses the first 72 bytes and silently drops the rest. Users with long passphrases think every character counts, and two passwords sharing a 72-byte prefix are identical to bcrypt. The cap is measured in bytes, not characters, because UTF-8 letters outside ASCII take 2–4 bytes.

**10. How do you decide what a container may know?**
Least privilege per process. List each service's environment explicitly instead of loading one shared `.env`. Make the config validate only what that process needs. Put processes that handle untrusted input (the ffmpeg worker) on an internal network with no internet access. A compromise of one container then exposes only its own secrets and can't easily reach the outside world.
