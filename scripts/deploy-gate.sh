#!/usr/bin/env bash
# The ONLY thing the GitHub Actions deploy key may run on the server (REVIEW L9).
#
# Installed by server-setup.sh as /usr/local/sbin/micky-deploy-gate (owned by root, so the
# deploy user cannot change it) and pinned in ~/.ssh/authorized_keys:
#
#   command="/usr/local/sbin/micky-deploy-gate",restrict ssh-ed25519 AAAA... github-actions-deploy
#
# `restrict` turns off port/agent/X11 forwarding and the TTY; `command=` replaces whatever the
# client asked for with this script, which reads the request from $SSH_ORIGINAL_COMMAND and
# accepts exactly two:
#
#   ff-upload               stdin: tar.gz with docker-compose.prod.yml, Caddyfile, .env.prod.example
#                           The compose file is checked first: only our images and the pinned
#                           official ones, no privileged/host-namespace containers, no extra
#                           capabilities, no bind mounts except ./Caddyfile.
#   ff-deploy <tag> <user>  stdin: a short-lived ghcr.io token. Logs in, runs
#                           /opt/micky/scripts/deploy.sh <tag>, logs out.
#
# Scripts in /opt/micky/scripts are NOT updated through this key; copy them by hand with
# your own key when they change (docs/DEPLOYMENT.md, "Updating the server scripts").
# Residual risk, stated honestly: whoever controls the deploy key AND can push images to
# ghcr.io/<you> can still run their image here. The gate stops a stolen key alone from getting
# a shell, mounting the host or running arbitrary images.
set -euo pipefail

APP_DIR="${FF_DIR:-/opt/micky}"
deny() { echo "deploy-gate: refused: $*" >&2; logger -t micky-deploy-gate "refused: $*" 2>/dev/null || true; exit 1; }

read -r -a ARGS <<<"${SSH_ORIGINAL_COMMAND:-}"
logger -t micky-deploy-gate "request: ${SSH_ORIGINAL_COMMAND:-<none>}" 2>/dev/null || true

image_prefix() {
  grep -E '^IMAGE_PREFIX=' "$APP_DIR/.env" | tail -n 1 | cut -d= -f2- | tr -d '"'"'"
}

case "${ARGS[0]-}" in
  ff-upload)
    [[ ${#ARGS[@]} -eq 1 ]] || deny "ff-upload takes no arguments"
    stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' EXIT
    # 1 MB is far more than three text files need; stops a disk-filling upload.
    head -c 1048576 | tar -xzf - -C "$stage" --no-same-owner --no-same-permissions ||
      deny "not a valid tar.gz"
    while IFS= read -r -d '' entry; do
      case "${entry#"$stage"/}" in
        docker-compose.prod.yml | Caddyfile | .env.prod.example) [[ -f "$entry" && ! -L "$entry" ]] || deny "not a plain file: $entry" ;;
        *) deny "unexpected file in upload: ${entry#"$stage"/}" ;;
      esac
    done < <(find "$stage" -mindepth 1 -print0)
    [[ -f "$stage/docker-compose.prod.yml" && -f "$stage/Caddyfile" ]] || deny "upload must contain docker-compose.prod.yml and Caddyfile"

    # Validate the compose file exactly as Compose will read it (with the server's .env).
    check="$(mktemp -d)"
    trap 'rm -rf "$stage" "$check"' EXIT
    cp "$stage/docker-compose.prod.yml" "$check/docker-compose.yml"
    cp "$stage/Caddyfile" "$check/Caddyfile"
    cp "$APP_DIR/.env" "$check/.env"
    docker compose --project-directory "$check" -f "$check/docker-compose.yml" config --format json >"$check/config.json" ||
      deny "docker compose config failed"
    PREFIX="$(image_prefix)" CHECK_DIR="$check" python3 - "$check/config.json" <<'PY' || deny "compose file failed the safety checks"
import json, os, re, sys
cfg = json.load(open(sys.argv[1]))
prefix = re.escape(os.environ["PREFIX"])
allowed_images = [
    rf"^{prefix}/micky-(api|web|verifier):[A-Za-z0-9._-]+$",
    r"^caddy:2-alpine$", r"^postgres:16-alpine$", r"^redis:7-alpine$",
]
caddyfile = os.path.join(os.environ["CHECK_DIR"], "Caddyfile")
bad = []
for name, svc in cfg.get("services", {}).items():
    image = svc.get("image", "")
    if not any(re.match(p, image) for p in allowed_images):
        bad.append(f"{name}: image {image!r} is not allowed")
    if "build" in svc:
        bad.append(f"{name}: build is not allowed on the server")
    if svc.get("privileged"):
        bad.append(f"{name}: privileged")
    for key in ("network_mode", "pid", "ipc", "userns_mode", "uts"):
        if svc.get(key) == "host":
            bad.append(f"{name}: {key}: host")
    for key in ("cap_add", "devices", "security_opt"):
        if svc.get(key):
            bad.append(f"{name}: {key} is not allowed")
    for vol in svc.get("volumes", []):
        if vol.get("type") == "bind" and vol.get("source") != caddyfile:
            bad.append(f"{name}: bind mount {vol.get('source')!r} is not allowed")
for line in bad:
    print("deploy-gate:", line, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
    install -m 0640 "$stage/docker-compose.prod.yml" "$APP_DIR/docker-compose.yml"
    install -m 0644 "$stage/Caddyfile" "$APP_DIR/Caddyfile"
    if [[ -f "$stage/.env.prod.example" ]]; then install -m 0644 "$stage/.env.prod.example" "$APP_DIR/.env.prod.example"; fi
    echo "deploy-gate: compose file and Caddyfile updated"
    ;;

  ff-deploy)
    [[ ${#ARGS[@]} -eq 3 ]] || deny "usage: ff-deploy <tag> <ghcr-user>"
    TAG="${ARGS[1]}"
    GHCR_USER="${ARGS[2]}"
    [[ "$TAG" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || deny "bad tag"
    [[ "$GHCR_USER" =~ ^[A-Za-z0-9-]{1,39}(\[bot\])?$ ]] || deny "bad user"
    IFS= read -r TOKEN || true
    [[ -n "${TOKEN:-}" ]] || deny "no registry token on stdin"
    printf '%s' "$TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
    status=0
    "$APP_DIR/scripts/deploy.sh" "$TAG" || status=$?
    docker logout ghcr.io >/dev/null || true
    exit "$status"
    ;;

  *) deny "unknown command '${ARGS[0]-}'" ;;
esac
