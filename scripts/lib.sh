#!/usr/bin/env bash
# Shared helpers for the Micky server scripts. Sourced, not run.
# shellcheck shell=bash

# Folder holding docker-compose.yml and .env on the server (default: the parent
# of this scripts/ folder, i.e. /opt/micky).
FF_DIR="${FF_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FF_ENV_FILE="${FF_ENV_FILE:-$FF_DIR/.env}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Reads KEY from the .env file without executing it (values may contain $, spaces, quotes).
# Usage: env_get KEY [default]
env_get() {
  local key="$1" default="${2-}" line value
  if [[ -n "${!key-}" ]]; then # an exported variable wins (handy for testing)
    printf '%s' "${!key}"
    return
  fi
  line="$(grep -E "^[[:space:]]*${key}=" "$FF_ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    printf '%s' "$default"
    return
  fi
  value="${line#*=}"
  value="${value%$'\r'}"
  # strip one pair of surrounding quotes
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
  printf '%s' "$value"
}

# Sets KEY=value in the .env file (adds the line if missing).
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "$FF_ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$FF_ENV_FILE" >"$tmp"
  else
    cat "$FF_ENV_FILE" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  cat "$tmp" >"$FF_ENV_FILE" # keep the original file's permissions (600)
  rm -f "$tmp"
}

compose() { docker compose --project-directory "$FF_DIR" -f "$FF_DIR/docker-compose.yml" "$@"; }

# Runs a PostgreSQL client tool (pg_dump, psql) against the database.
# PG_MODE=compose (default): inside the postgres container.
# PG_MODE=native: the host's own client tools, using PGHOST/PGPORT/PGPASSWORD
#                 (servers without Docker, or testing the scripts).
pg_tool() {
  if [[ "${PG_MODE:-compose}" == "native" ]]; then
    "$@"
  else
    compose exec -T postgres "$@"
  fi
}

# rclone remote for backups, configured entirely from environment variables
# (no rclone.conf file to manage). BACKUP_DEST overrides it, e.g. a local folder.
setup_rclone() {
  export RCLONE_CONFIG="${RCLONE_CONFIG:-/dev/null}" # remotes come from env vars only
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  RCLONE_CONFIG_R2_ENDPOINT="$(env_get BACKUP_S3_ENDPOINT)"
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="$(env_get BACKUP_S3_ACCESS_KEY_ID)"
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$(env_get BACKUP_S3_SECRET_ACCESS_KEY)"
  export RCLONE_CONFIG_R2_ENDPOINT RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
  export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true # a bucket-scoped token can't create buckets
  export RCLONE_CONFIG_R2_REGION=auto
  BACKUP_DEST="${BACKUP_DEST:-r2:$(env_get BACKUP_S3_BUCKET micky-backups)/postgres}"
  command -v rclone >/dev/null || die "rclone is not installed (sudo apt-get install -y rclone)"
}

# ---------- Backup encryption (age, https://age-encryption.org) ----------
# Backups are encrypted on the server to one or more age PUBLIC keys. The matching private key
# (identity) is kept OFF the server (password manager, laptop, printed), so neither a
# compromised VM nor a leaked R2 token can read a backup. docs/DEPLOYMENT.md section 9.
#
#   BACKUP_AGE_RECIPIENTS       age1... public keys, separated by spaces or commas
#   BACKUP_AGE_RECIPIENTS_FILE  or: a file with one public key per line
#
# Prints the `age` recipient arguments, one per line (read with mapfile).
age_recipient_args() {
  local recipients file key found=0
  command -v age >/dev/null || die "age is not installed (sudo apt-get install -y age)"
  recipients="$(env_get BACKUP_AGE_RECIPIENTS)"
  file="$(env_get BACKUP_AGE_RECIPIENTS_FILE)"
  for key in ${recipients//,/ }; do
    [[ "$key" =~ ^age1[0-9a-z]{58}$ ]] || die "BACKUP_AGE_RECIPIENTS: not an age public key: $key"
    printf '%s\n%s\n' -r "$key"
    found=1
  done
  if [[ -n "$file" ]]; then
    [[ -r "$file" ]] || die "BACKUP_AGE_RECIPIENTS_FILE $file is not readable"
    printf '%s\n%s\n' -R "$file"
    found=1
  fi
  [[ "$found" == 1 ]] || die "set BACKUP_AGE_RECIPIENTS (an age1... public key) in $FF_ENV_FILE: backups are never stored unencrypted"
}

# The private key used to DECRYPT a backup, for restores only. Never leave it on the server:
# copy it up for the restore, then delete it (the restore scripts remind you).
#   --identity FILE  or  BACKUP_AGE_IDENTITY=FILE
age_identity_file() {
  local file="${1:-${BACKUP_AGE_IDENTITY:-}}"
  [[ -n "$file" ]] || die "encrypted backup: pass --identity /path/to/backup-key.txt (the age private key kept off the server)"
  [[ -r "$file" ]] || die "cannot read the identity file $file"
  printf '%s' "$file"
}
