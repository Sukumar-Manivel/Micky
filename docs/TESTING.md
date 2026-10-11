# Testing Micky

How Micky is tested, how to run each suite, what the tests found, and how to talk about it in an interview.

## The test pyramid

```
            ┌────────────────────────┐
            │  Browser e2e (15)      │  e2e/  Playwright, whole stack, real Chromium
            ├────────────────────────┤
            │  API e2e (146)         │  apps/api/test/  real Nest app + Postgres + Redis,
            │                        │  supertest; fake verifier / signed webhooks
            ├────────────────────────┤
            │  Unit (91 API, 26 web, │  pure functions: money splits, licence rules, pHash,
            │  51 verifier)          │  risk, file sniffing, HMAC, session store, HLS policy
            └────────────────────────┘
```

| Layer | Where | Speed | What it is good at |
|---|---|---|---|
| **Unit** | `apps/api/src/**/*.spec.ts` (Vitest), `apps/web/lib/*.test.ts` (Vitest), `services/verifier/tests` (pytest) | about 3 s | Rules with many cases: `splitSale` rounding, `licenceBlocker`, magic bytes, ISO 6709 parsing, pHash distance, risk signals, signature checks, the single-flight refresh, the HLS error policy |
| **API e2e** | `apps/api/test/*.e2e-spec.ts` | about 75 s | One module through HTTP against a real database: validation, 404-not-403, races (parallel uploads, payouts, exclusive purchases, webhook vs verify), idempotent webhooks, processing with a fake verifier that the test controls, the real BullMQ worker, Socket.IO delivery |
| **Browser e2e** | `e2e/tests/*.spec.ts` (Playwright) | about 60 s | What a person actually does, across every process: upload → worker → review → approval → live alert → preview → mock checkout → download → payout. It catches wiring bugs that no single layer can see: CORS, cookies, runtime config, hls.js, the realtime toast |

Most tests sit at the bottom because they are fast and precise. The top layer is small, but it covers the money path, because that path crosses five processes.

## How to run each suite

PostgreSQL and Redis must be running locally (`service postgresql start`, `redis-server --daemonize yes`). Each person or agent uses their **own** test database and Redis db, so parallel runs don't wipe each other's data.

```bash
# API: lint, typecheck, unit, e2e
cd apps/api
npm run lint && npm run typecheck && npm test
createdb -O micky micky_test_<you>     # once
TEST_DATABASE_URL=postgresql://micky:micky@localhost:5432/micky_test_<you> \
TEST_REDIS_URL=redis://localhost:6379/<n> npm run test:e2e

# Web: lint, typecheck, unit, build
cd apps/web && npm run lint && npm run typecheck && npm test && npm run build

# Verifier: lint, format, unit
cd services/verifier && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/python -m pytest

# Browser e2e (builds API + web, boots the whole stack on ports 3310/4310/8310)
make e2e                        # see e2e/README.md for options and debugging
```

CI (`.github/workflows/ci.yml`) runs the same steps in the jobs `api`, `web`, `verifier` and `e2e`. The `e2e` job does the following:
- starts Postgres and Redis service containers;
- builds the API and the web app;
- installs the verifier's runtime requirements (no torch);
- runs `npx playwright install --with-deps chromium`;
- uploads the HTML report, traces and stack logs when it fails.

## What each suite covers

- **API unit:**
  - `common/money` (fee rounding: `fee + share === amount`);
  - `orders/licence-rules`, payment signatures (HMAC, checked against `openssl`);
  - `media/file-type`, `processing/media-metadata`, `phash`, `risk`;
  - `incidents/trend`, `market/geo`, `stream` (access rules, segment-name regex, safe file names).
- **API e2e:**
  - `auth`: registration, login timing, refresh rotation and reuse detection, and the **parallel-registration** regression;
  - `media`: 17 validation cases, 413/415/409, parallel duplicates, full processing with a fake verifier, verifier down → retry → degrade, the real worker;
  - `market`, `stream`: filters, radius, availability, HLS/key/segment routes, tampered/expired tokens, revocation;
  - `orders`, `orders-razorpay`: licence rules, exclusive race, signed `/verify`, webhook replay, invalid signature and underpayment;
  - `earnings`: 10 parallel payouts against one balance;
  - `admin`, `reports`;
  - `realtime`: Socket.IO over a raw WebSocket.
- **Web unit:** money parsing and formatting, the session store's single-flight refresh, runtime config, API client helpers, the domain hint, and the HLS error policy.
- **Verifier:** auth middleware, size limits, multipart parsing, C2PA, pHash, and the detector with a fake model.
- **Browser e2e:** see `e2e/README.md`:
  - the whole money path with three users;
  - the realtime toast;
  - the encrypted HLS preview, and no download before payment;
  - a SHA-256-verified download;
  - a payout;
  - negative paths: a newsroom on admin pages, a pending newsroom, a duplicate and a fake upload, and an exclusive licence blocking a second sale.

## Results of the test pass (2026-10-11)

| Suite | Before | After |
|---|---|---|
| API lint / typecheck | clean / clean | clean / clean |
| API unit | 91 passed | 91 passed |
| API e2e | 145 passed (10 files) | **146** passed (+1 regression test) |
| Web lint / typecheck / build | clean | clean |
| Web unit | 22 passed (5 files) | **26** passed (6 files, +4 regression tests) |
| Verifier ruff / format / pytest | clean / clean / 51 passed | unchanged |
| Browser e2e | did not exist | **15 passed** (two consecutive runs, about 60 s each) |
| `actionlint` on the workflows | n/a | clean |

### Bugs found and fixed

**1. The preview player looped forever when a browser could not decode the video** (`apps/web/components/preview-player.tsx`)
- **Symptom:** in a browser without H.264/AAC support (Playwright's Chromium, and some Linux Chromium/Firefox builds), the media page downloaded `seg_000.ts` about 9 times a second for as long as it was open: 99 requests in 11 s. Each request costs the API a token check, two database reads and a 96 KB storage read. The viewer saw a black box with no explanation.
- **Cause:** every fatal hls.js `MEDIA_ERROR` called `hls.recoverMediaError()`, with no limit. `bufferAddCodecError` fails again on every attempt, so recovery reloaded the segment and failed again. Any other fatal error fetched a new preview session, which was also unbounded.
- **Fix:** a small pure policy, `apps/web/lib/hls-errors.ts`, following the hls.js guidance:
  - recover once;
  - then `swapAudioCodec()` and recover once more;
  - then give up and show "This browser cannot play the preview video…" with a "Try again" button;
  - session refreshes are capped at 3 per minute.
- **Regression tests:**
  - `apps/web/lib/hls-errors.test.ts` (4 unit tests);
  - money-path step 7, which asserts at most 6 segment requests and the explanatory message when the browser can't decode H.264. With the old player this step fails.

**2. Two simultaneous registrations with the same email returned 500** (`apps/api/src/auth/auth.service.ts`)
- **Symptom:** a double submit, or two tabs, sending `POST /auth/register` with one email got one 201 and then `500 Internal Server Error`, with a raw Postgres unique-violation in the logs.
- **Cause:** "check the email exists, then insert" is a race. The unique index on `users.email` correctly stops the second insert, but the error wasn't translated.
- **Fix:** catch Postgres error `23505` around the registration transaction and answer the same 409 as the normal duplicate path.
- **Regression test:** `test/auth.e2e-spec.ts`, "answers 409, not 500, when the same email registers twice at the same moment". It fires 4 parallel registrations and expects `[201, 409, 409, 409]`. Before the fix it fails with 500s.

**3. `make help` hid the new targets** (`Makefile`)
- **Cause:** the help regex `^[a-zA-Z_-]+:` doesn't allow digits, so `e2e` wasn't listed.
- **Fix:** the regex now allows digits.

### Explored and found working (no change needed)

- **Tokens:**
  - garbage, expired, `alg: none`, and signed with the dev default secret: all 401;
  - refresh with no cookie or a bogus cookie: 401;
  - an **8-second access-token TTL in the browser**: the live socket reconnects with fresh tokens every expiry, API calls and the download refresh transparently, and the alert still arrives.
- **Other users' IDs:** another uploader's media (GET, PATCH, DELETE, preview), another channel's order (GET, download, mock-pay), and media in review seen by a channel: all 404.
- **Files:** a text file renamed `.mp4` (415), a 26 MB "JPEG" (413), two files (400), no file (400), a future date, a bad latitude and price rules (400). No temp files are left behind.
- **Exclusive licence:** two channels mock-paying at the same instant give one 200 and one 409, one PAID order, one ledger credit, and the loser's order FAILED and logged `NEEDS REFUND`.
- **Webhook, live against an API in `razorpay` mode:**
  - a bad signature gets 400;
  - a valid one marks the order PAID;
  - a replay with the same event id answers "already processed";
  - the same payment under a new event id answers `already_paid`;
  - a re-formatted body with the original signature gets 400 (the raw body is what's signed);
  - there is exactly one ledger credit.
- **Verifier:**
  - Down: the worker retried at 15 s, 30 s and 60 s. On the 4th attempt it published with a `VERIFIER_UNAVAILABLE` warning.
  - Slow (40 s, longer than BullMQ's 30 s lock): one call, processed once, no stalled job.
- **Socket.IO:** approved channels and the admin receive `media.approved` and `incident.updated`. A pending channel and an uploader get an `error` event and are disconnected. The Origin allow-list only applies to HTTP long-polling, which is acceptable because auth is a bearer token, not a cookie.
- **Takedown after a sale:** the report is resolved with `removeMedia`. Old and new download links stop working, and the uploader's earning stays.
- **Every page crawled as anonymous, uploader, newsroom and admin:** no uncaught errors and no sideways overflow.

### Noticed but not changed

- **Seed and login disagree about valid emails.** The seed accepts an admin email that the login DTO's `IsEmail` rejects. An address with a digit in the TLD, such as `admin@micky.e2e`, can be seeded but can never log in. The e2e suite uses `.test`.
- **Unpaid checkouts never expire.** A `CREATED` order keeps its original amount and can be paid later, even after the uploader has raised the price. The 30-minute window only applies to *reusing* a checkout. Fixing it needs a product decision: either expire checkouts, or refuse and refund payments below the current price.
- **Local dev setup.** `apps/api/.env` leaves `INTERNAL_TOKEN` empty. The API then uses `dev-insecure-internal_token-change-me`, while an empty token on the verifier rejects every call. A local stack started from the READMEs therefore never gets AI or C2PA results unless both sides set the same token. The e2e stack sets it explicitly.
- Security findings are in `docs/REVIEW.md` and are handled by a separate fix wave.

## Interview answers on testing strategy

**Why use end-to-end tests for money flows, when unit tests are faster?**
- A purchase crosses five processes: browser, API, Postgres, the payment provider and the worker's outputs (the original file).
- The bugs that cost money often live in the gaps between them: a CORS or cookie mistake that breaks checkout, a signed URL that points to the wrong host, a download that serves the wrong bytes.
- Unit tests prove each rule, such as the fee split or the licence rules. One e2e test proves that a real person can pay and receives exactly the file that was uploaded: we compare SHA-256 hashes, not just "a download started".
- The same applies to the uploader: the e2e test checks that the share shows up and can be withdrawn.
- It is a small number of tests on the paths where a failure is most expensive.

**How do you avoid flaky tests?**
- **Isolation:** a fresh database for each run, unique users in every test, and no state shared between files.
- **No arbitrary sleeps:** web-first assertions that auto-wait, `expect.poll` against the API for the background worker, and `waitForResponse` for network checks.
- **Control the network:** block third-party hosts such as map tiles, so the tests don't depend on the internet. Where a timing race could exist, remove it. For example, the video segments are held with `page.route` until the player has been inspected.
- **Respect the system's real constraints:** the API's rate limits and refresh-token reuse detection. The suite logs the admin in once, sets users up through the API, and never clones a saved session.
- **No automatic retries**, so a real failure is never hidden.
- **When something does fail,** the trace, video and server logs are uploaded.
- I ran the suite twice in a row to check it is stable.

**Why separate test databases?**
- Tests must start from a known state and must not interfere with each other.
- Each developer or CI job gets its own database (`micky_test_<name>`) and Redis db index.
- The API e2e suite truncates between tests. The browser suite drops and recreates its database and applies the real migrations, which also tests the migrations.
- Using the real Postgres, not SQLite or a mock, matters here. The correctness relies on Postgres features: `SELECT … FOR UPDATE`, advisory locks, partial unique indexes and `ON CONFLICT`.

**How do you mock external services, and what do you refuse to mock?**
- Mock at the boundary you don't own, behind an interface you do own.
- **Payments:** `PaymentProvider` has a `mock` implementation for demos and e2e. Razorpay mode is tested by signing webhook bodies and checkout signatures with test secrets, and stubbing only `orders.create`.
- **The AI verifier:** the API e2e tests run a tiny in-test HTTP server, so they control scores and can simulate 503s, 401s and slowness. The browser e2e runs the real verifier without the model.
- **Never mocked:** the database, the queue, ffmpeg and our own HTTP layer. That is where our own bugs live.
- The contract with each external service is kept honest by validating its responses (the verifier's JSON is parsed field by field) and by documenting it in `docs/API.md`.

**What did the browser tests find that the other layers couldn't?**
- The infinite preview retry loop. Every API test passed, because the API served the segments correctly. Only a real browser that couldn't decode H.264 showed the player hammering the server.
- That is the argument for keeping a thin e2e layer on top.
