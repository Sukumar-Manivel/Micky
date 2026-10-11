# Shortcuts for the local Docker stack and infra checks. `make help` lists them.
# The production server uses scripts/*.sh instead (see docs/DEPLOYMENT.md).

COMPOSE ?= docker compose
SCRIPTS := $(wildcard scripts/*.sh)

.PHONY: help up down logs ps seed migrate config clean lint-infra e2e e2e-install

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

up: ## Build and start the whole stack in the background
	$(COMPOSE) up -d --build

down: ## Stop the stack (data volumes are kept)
	$(COMPOSE) down

logs: ## Follow logs of api, worker and web
	$(COMPOSE) logs -f api worker web

ps: ## Show container status and health
	$(COMPOSE) ps

seed: ## Create the admin user (admin@firstframe.local)
	$(COMPOSE) run --rm seed

migrate: ## Apply database migrations
	$(COMPOSE) run --rm migrate

config: ## Validate both compose files (prod with placeholder values)
	$(COMPOSE) config --quiet
	@tmp=$$(mktemp -d) && cp infra/docker-compose.prod.yml $$tmp/docker-compose.yml && cp infra/Caddyfile $$tmp/ && \
	  sed -e 's/CHANGE_ME/placeholder/g' infra/.env.prod.example > $$tmp/.env && \
	  $(COMPOSE) --project-directory $$tmp -f $$tmp/docker-compose.yml config --quiet && rm -rf $$tmp && echo "compose files OK"

clean: ## Stop the stack AND delete its volumes (database, uploads)
	$(COMPOSE) down -v

lint-infra: ## shellcheck + actionlint + hadolint (if installed)
	shellcheck -x $(SCRIPTS)
	actionlint
	hadolint --failure-threshold error apps/api/Dockerfile apps/web/Dockerfile services/verifier/Dockerfile

# ---------- Browser end-to-end tests (Playwright, see e2e/README.md) ----------
# Needs local PostgreSQL + Redis and ffmpeg; boots verifier, API, worker and web itself.
PLAYWRIGHT_BROWSERS_PATH ?= $(if $(wildcard /opt/pw-browsers),/opt/pw-browsers,)
export PLAYWRIGHT_BROWSERS_PATH

e2e-install: ## Install e2e deps (browsers: `cd e2e && npx playwright install chromium`)
	cd e2e && npm ci --no-audit --no-fund

e2e: ## Build API + web, then run the Playwright suite against a fresh stack
	cd apps/api && npm run build
	cd apps/web && npm run build
	cd e2e && npx playwright test
