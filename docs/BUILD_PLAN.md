# Build plan and team rules

How Micky was built by a lead plus a team of AI agents, and the rules every builder follows. Keep it: it is also a good answer to "how did you organise the work?" in an interview.

## Workflow

| Phase | Agents | Output |
|---|---|---|
| 1. Research | 3 in parallel: infrastructure, payments/legal, verification | `docs/RESEARCH.md` |
| 2. Architecture | Lead | Database schema, `docs/API.md` contract, shared modules, auth (tested) |
| 3. Build | 5 in parallel, with disjoint file ownership | Feature modules, verifier service, web app |
| 4. Test & review | 1 test engineer + 1 independent reviewer | Bug fixes, `docs/REVIEW.md` |
| 5. Deploy | 1 | Docker Compose, Caddy, CI/CD, `docs/DEPLOYMENT.md` |

## File ownership in phase 3

Builders work in the same repository at the same time, so **each builder only creates or edits files it owns**. Anything else is requested from the lead in the builder's final report.

| Builder | Owns |
|---|---|
| **media** | `apps/api/src/media/**`, `src/processing/**`, `src/incidents/**`, `src/worker.ts`, `src/worker.module.ts`, `test/media*.e2e-spec.ts`, `docs/learning/media-and-processing.md` |
| **verifier** | `services/verifier/**`, `docs/learning/verifier.md` |
| **market** | `apps/api/src/market/**`, `src/stream/**`, `src/realtime/**`, `test/market*.e2e-spec.ts`, `test/stream*.e2e-spec.ts`, `docs/learning/marketplace-and-streaming.md` |
| **commerce** | `apps/api/src/orders/**`, `src/earnings/**`, `src/admin/**`, `src/reports/**`, `test/orders*.e2e-spec.ts`, `test/earnings*`, `test/admin*`, `test/reports*`, `docs/learning/payments-and-admin.md` |
| **web** | `apps/web/**`, `docs/learning/frontend.md` |

**Owned by the lead (read-only for builders):**
- `apps/api/src/db/**` (schema, migrations)
- `src/common/**`, `src/config/**`, `src/auth/**`, `src/storage/**`
- `src/app.module.ts`, `src/main.ts`
- `apps/api/package.json`
- `test/helpers.ts`, `test/global-setup.ts`
- `docs/API.md`

## Conventions (API)

- **ESM TypeScript (NestJS 12):** every relative import ends in `.js` (`import { x } from './x.js'`).
- **Database:** inject with `constructor(@InjectDb() private readonly db: Database)`. Use Drizzle from `src/db/schema.ts`; do not change the schema. Use transactions (`db.transaction`) for anything that touches money or more than one row that must stay consistent.
- **Config:** inject `AppConfig`. Never read `process.env` in feature code.
- **Auth:**
  - Every route requires a logged-in user by default. Use `@Public()`, `@Roles('CHANNEL', 'ADMIN')`, `@ApprovedChannel()` and `@CurrentUser() user: AuthUser` from `src/common/auth.decorators.ts`.
  - Check ownership in the service ("this uploader owns this media"). Return 404, not 403, for other users' resources, so we don't reveal what exists.
- **Shared code:**
  - Files: `StorageService` and `storageKeys`.
  - Signed URLs: `UrlService` and `TOKEN`.
  - Signed tokens: `SigningService`.
  - Pagination: `PaginationQuery`, `paginated`, `offsetOf`.
  - Prices and splits: `splitSale`, `DEFAULT_PRICES`, `MIN/MAX_PRICE_PAISE`.
  - Responses: `toMediaOwnerView`, `toMediaMarketView`, `toVerificationView`.
- **Cross-module contracts:** `IncidentsService` (owned by media) and `RealtimeService` (owned by market) are global. Keep their method signatures exactly as written.
- **Validation:** class-validator DTOs on every body and query. The global `ValidationPipe` uses `whitelist` and `forbidNonWhitelisted`.
- **Money:** integer paise only.
- **Dependencies:** do not add npm packages to `apps/api`. Ask the lead.
- **Testing:**
  - Unit tests go next to the code as `*.spec.ts`.
  - E2E tests go in `test/` and use `test/helpers.ts`.
  - Run your own e2e files against **your own** test database, so builders don't wipe each other's data: `TEST_DATABASE_URL=postgresql://micky:micky@localhost:5432/micky_test_<builder> TEST_REDIS_URL=redis://localhost:6379/<n> npx vitest run --config vitest.config.e2e.ts test/<your-file>`
- **Before finishing:** `npm run typecheck` must pass.
- **Git:** do not commit. The lead commits after each wave.

## Learning notes

Every builder writes `docs/learning/<area>.md`:
- What was built and why.
- How a request flows through the code (file by file).
- Key concepts explained simply.
- Trade-offs made.
- **Interview questions with model answers** for that area.

The project owner is a student preparing for interviews: they must be able to explain every part.
