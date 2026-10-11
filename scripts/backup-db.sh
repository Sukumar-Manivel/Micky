#!/usr/bin/env bash
# Nightly PostgreSQL backup: pg_dump -> gzip -> Cloudflare R2, keeping N days.
#
#   scripts/backup-db.sh               # dump, upload, prune old dumps
#   scripts/backup-db.sh --local-only  # dump to /var/backups/firstframe only (no upload)
#
# Cron (installed by scripts/server-setup.sh), every night at 02:30 server time:
#   30 2 * * * /opt/firstframe/scripts/backup-db.sh >> /var/log/firstframe-backup.log 2>&1
#
# Reads from /opt/firstframe/.env: POSTGRES_USER, POSTGRES_DB, BACKUP_S3_ENDPOINT,
# BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY,
# BACKUP_RETENTION_DAYS. Needs: docker, gzip, rclone.
set -euo pipefail
umask 077 # dumps contain password hashes and personal data: owner-only files

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LOCAL_ONLY=false
case "${1-}" in
  --local-only) LOCAL_ONLY=true ;;
  "") ;;
  -h | --help)
    sed -n '2,13p' "$0"
    exit 0
    ;;
  *) die "unknown option: $1" ;;
esac

BACKUP_DIR="${BACKUP_DIR:-/var/backups/firstframe}"
RETENTION_DAYS="$(env_get BACKUP_RETENTION_DAYS 14)"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS must be a whole number"
PG_USER="$(env_get POSTGRES_USER firstframe)"
PG_DB="$(env_get POSTGRES_DB firstframe)"

mkdir -p "$BACKUP_DIR"

# Only one backup at a time (a slow upload must not overlap the next run).
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || die "another backup is still running"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/firstframe-$STAMP.sql.gz"
PARTIAL="$FILE.partial"
trap 'rm -f "$PARTIAL"' EXIT

log "dumping database '$PG_DB' -> $FILE"
# --clean --if-exists: the dump drops objects before recreating them on restore.
# --no-owner --no-privileges: restores cleanly even if the role name changes.
pg_tool pg_dump --username="$PG_USER" --dbname="$PG_DB" \
  --clean --if-exists --no-owner --no-privileges \
  | gzip -6 >"$PARTIAL"

gzip -t "$PARTIAL" || die "the dump is not a valid gzip file"
# An empty database still dumps a few KB of SET statements; anything tiny means pg_dump failed.
[[ "$(stat -c %s "$PARTIAL")" -gt 1024 ]] || die "the dump is suspiciously small"
mv "$PARTIAL" "$FILE"
log "dump OK ($(du -h "$FILE" | cut -f1))"

if [[ "$LOCAL_ONLY" == false ]]; then
  setup_rclone
  log "uploading to $BACKUP_DEST/"
  rclone copyto "$FILE" "$BACKUP_DEST/$(basename "$FILE")" --retries 5 --low-level-retries 10
  log "pruning remote dumps older than ${RETENTION_DAYS} days"
  rclone delete "$BACKUP_DEST" --min-age "${RETENTION_DAYS}d" --include 'firstframe-*.sql.gz'
fi

log "pruning local dumps older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -name 'firstframe-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete

log "backup finished"
