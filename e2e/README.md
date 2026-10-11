# Micky browser end-to-end tests

Playwright tests that drive the real product in Chromium against the whole stack: PostgreSQL, Redis, the Python verifier, the NestJS API, the BullMQ worker and the Next.js web app, with `PAYMENTS_PROVIDER=mock`. Nothing in the app is mocked except the payment gateway.

## Run

```bash
make e2e                 # from the repo root: builds API + web, then runs the suite
# or, step by step:
(cd apps/api && npm run build) && (cd apps/web && npm run build)
cd e2e && npm ci && npx playwright test
npx playwright show-report   # HTML report, with traces and videos of failures
```

You need the following:
- PostgreSQL on `localhost:5432`, with a role `micky/micky` that can create databases.
- Redis on `localhost:6379`.
- `ffmpeg` on the PATH.
- The verifier's venv at `services/verifier/.venv`, or set `E2E_PYTHON` to a Python that has `services/verifier/requirements.txt` installed.
- Chromium. Run `npx playwright install chromium` once. On the team dev box, Chromium is preinstalled: use `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, which `make e2e` sets automatically.

### What global setup does (`global-setup.ts`, `support/stack.ts`)

1. Generates the test footage with ffmpeg into `.fixtures/`:
   - small H.264/AAC MP4s with GPS and capture-time tags, unique per run;
   - a text file named `.mp4`.
2. Drops and recreates the database `micky_e2e`, flushes Redis db 13, then runs the compiled migrations and the admin seed.
3. Starts the verifier (`:8310`, no AI model), the API (`:4310`), the worker and the web standalone server (`:3310`), and waits until each is ready. Logs go to `.stack/<name>.log`.

Teardown stops every process group. The database is kept so you can inspect a failed run. `E2E_DROP_DB=1` drops it too.

The ports are not the dev defaults, so a running dev stack does not interfere. Every setting can be overridden with an environment variable (`support/env.ts`):
- `E2E_DATABASE_URL`, `E2E_REDIS_URL`
- `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_VERIFIER_PORT`
- `E2E_PYTHON`
- `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`

### Debugging against a stack you keep running

```bash
npm run stack:up                      # boot once (fresh DB)
E2E_EXTERNAL_STACK=1 npx playwright test tests/negative-paths.spec.ts --headed
npm run stack:down                    # E2E_DROP_DB=1 to drop the database as well
```

The specs use unique names and emails, so they can be rerun against the same database.

## What is covered

**`tests/money-path.spec.ts`** is one story with three people, each in their own browser context:
1. A witness registers and uploads a clip, using "Use my location" (geolocation is granted to the context).
2. The worker processes it, and the dashboard turns to "In review" without a reload.
3. A newsroom registers and sees "waiting for approval".
4. The admin approves the newsroom.
5. The admin opens the review queue and checks the verification signals (risk, C2PA, AI detector unavailable, re-encoded, full metadata) and approves. The newsroom's open feed gets the Socket.IO `media.approved` alert as a toast.
6. The newsroom finds the incident in the feed, opens it, and opens the clip.
7. The preview:
   - The playlist, AES key and a segment load from signed URLs (encrypted HLS).
   - The video has `controlslist=nodownload`, the organisation watermark is drawn over it, and there is no download button or link.
   - If the browser can't decode H.264, the player says so and stops retrying (regression test).
8. The newsroom buys a licence through the mock checkout and downloads the original. Its SHA-256 matches the checksum the API stored at upload and the fixture file.
9. The witness sees the ₹1,050 earning (70% of ₹1,500), saves a UPI ID and requests a payout.
10. The admin marks the payout paid with a UTR. The witness sees it as paid, with the reference, and a balance of ₹0.

No uncaught page errors may occur along the way.

**`tests/negative-paths.spec.ts`**:
- A newsroom is redirected away from `/admin/*`, and the API answers 403 on admin routes.
- An unapproved newsroom sees the pending page on every newsroom URL, and the API answers 403 on the market and on checkout.
- The same file uploaded twice is rejected with the duplicate message. A text file renamed `.mp4` is rejected by the server's magic-byte check (415).
- An exclusive licence stops a second sale:
  - a stale page that still offers "Buy" gets the API's 409 explained;
  - a fresh page offers nothing to buy;
  - the API refuses both licence types;
  - the witness sees exactly one sale.

## Why it is built this way (flakiness)

- **Fresh database per run**, unique users per test, no shared fixtures between files.
- **One worker, in order.** The money path is a dependent story (`describe.serial`), so it stops at the first broken step.
- **No retries.** A retried payment step would hide real bugs.
- **No sleeps for app state.**
  - Web-first assertions (`expect(locator)` auto-waits).
  - `expect.poll` against the API for the worker.
  - `waitForResponse` for network checks.
  - Media segments are held with `page.route` while the player is inspected, so the check never races playback.
- **Hermetic.** Requests to non-localhost hosts (map tiles) are blocked, so tests never depend on the internet.
- **Rate limits.** The API allows 10 logins and 10 registrations per minute per IP, and the whole suite runs from one IP. So:
  - setup goes through the API;
  - the admin API session is logged in once per run;
  - the suite stays under both limits.
- **Refresh-token rotation.** Contexts are never cloned from a saved `storageState`. Reusing a rotated refresh cookie is treated as theft and logs the user out everywhere.

## Regenerating the README screenshots

`shots/` is not part of the test suite. It boots the same stack, creates realistic demo data (four incidents, two newsrooms, a purchase, a payout request and a report), and rewrites every image in `docs/screenshots/` at 1366 px (desktop) and 360 px (mobile):

```bash
(cd apps/api && npm run build) && (cd apps/web && npm run build)
cd e2e && npx playwright test --config shots/shots.config.ts
```
