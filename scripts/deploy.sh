#!/usr/bin/env bash
# Deploys (or rolls back to) one image tag ON THE SERVER. Called by
# .github/workflows/deploy.yml over SSH; also safe to run by hand:
#
#   /opt/firstframe/scripts/deploy.sh 3f2c1ab...   # a commit SHA that deploy.yml built
#   /opt/firstframe/scripts/deploy.sh latest
#
# Steps: record the tag in .env -> pull images -> run migrations -> recreate
# changed containers -> wait for the API health check -> prune old images.
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TAG="${1:-}"
[[ "$TAG" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "usage: $0 <image-tag>"
[[ -f "$FF_ENV_FILE" ]] || die "$FF_ENV_FILE is missing (copy .env.prod.example and fill it in)"
[[ -f "$FF_DIR/docker-compose.yml" ]] || die "$FF_DIR/docker-compose.yml is missing"

PREVIOUS="$(env_get IMAGE_TAG latest)"
env_set IMAGE_TAG "$TAG"
log "deploying $TAG (previous: $PREVIOUS)"

compose config --quiet # fail fast on a broken .env or compose file
compose pull --quiet

# Migrations first, against the database the old API is still using. Migrations
# must therefore stay backward compatible ("expand, then contract").
log "running migrations"
compose run --rm migrate

log "starting containers"
compose up -d --remove-orphans

# `up` doesn't notice a changed Caddyfile (it's a bind mount, not part of the
# image). Reload Caddy gracefully; recreate it if the mount went stale (the file
# was replaced rather than overwritten, so the container still sees the old one).
if [[ -n "$(compose ps -q caddy)" ]]; then
  host_sum="$(sha256sum "$FF_DIR/Caddyfile" | cut -d' ' -f1)"
  ctr_sum="$(compose exec -T caddy sha256sum /etc/caddy/Caddyfile | cut -d' ' -f1)"
  if [[ "$host_sum" != "$ctr_sum" ]]; then
    log "Caddyfile mount is stale: recreating caddy"
    compose up -d --force-recreate caddy
  else
    compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  fi
fi

log "waiting for the API to become healthy"
api_id="$(compose ps -q api)"
status=""
for _ in $(seq 1 40); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$api_id" 2>/dev/null || echo missing)"
  [[ "$status" == "healthy" ]] && break
  sleep 3
done
if [[ "$status" != "healthy" ]]; then
  compose logs --tail 80 api >&2 || true
  log "API is '$status' after 2 minutes. Roll back with: $0 $PREVIOUS"
  exit 1
fi

docker image prune -f --filter "until=168h" >/dev/null # keep a week of old images for rollbacks
compose ps
log "deployed $TAG"
