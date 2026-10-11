#!/usr/bin/env bash
# Restores the PostgreSQL database from a backup made by backup-db.sh.
#
#   scripts/restore-db.sh --list                    # list backups in R2 and on disk
#   scripts/restore-db.sh latest                    # newest backup in R2
#   scripts/restore-db.sh firstframe-20261011T023000Z.sql.gz   # that file from R2
#   scripts/restore-db.sh /var/backups/firstframe/firstframe-....sql.gz  # local file
#   add --yes to skip the confirmation prompt
#
# What it does:
#   1. saves a safety dump of the CURRENT database (backup-db.sh --local-only)
#   2. stops api + worker so nothing writes during the restore
#   3. drops and recreates the database, loads the dump in one transaction
#   4. runs migrations (in case the dump is older than the code) and starts api + worker
# Media files (the mediadata volume) are NOT part of this backup.
set -euo pipefail
umask 077

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

YES=false
SOURCE=""
for arg in "$@"; do
  case "$arg" in
    --yes | -y) YES=true ;;
    --list) SOURCE="--list" ;;
    -h | --help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *) SOURCE="$arg" ;;
  esac
done
[[ -n "$SOURCE" ]] || die "usage: $0 <latest | backup-file-name | /path/to/file.sql.gz | --list> [--yes]"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/firstframe}"
PG_USER="$(env_get POSTGRES_USER firstframe)"
PG_DB="$(env_get POSTGRES_DB firstframe)"
[[ "$PG_DB" =~ ^[A-Za-z0-9_]+$ ]] || die "POSTGRES_DB must be letters, digits and _ only"

if [[ "$SOURCE" == "--list" ]]; then
  setup_rclone
  echo "== Remote ($BACKUP_DEST)"
  rclone lsl "$BACKUP_DEST" --include 'firstframe-*.sql.gz' | sort -k2,3 || true
  echo "== Local ($BACKUP_DIR)"
  ls -lh "$BACKUP_DIR"/firstframe-*.sql.gz 2>/dev/null || echo "(none)"
  exit 0
fi

# ---- 1. Get the dump file ----
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [[ -f "$SOURCE" ]]; then
  FILE="$SOURCE"
else
  setup_rclone
  NAME="$SOURCE"
  if [[ "$SOURCE" == "latest" ]]; then
    NAME="$(rclone lsf "$BACKUP_DEST" --include 'firstframe-*.sql.gz' | sort | tail -n 1)"
    [[ -n "$NAME" ]] || die "no backups found in $BACKUP_DEST"
  fi
  [[ "$NAME" =~ ^firstframe-[0-9TZ]+\.sql\.gz$ ]] || die "not a backup file name: $NAME"
  log "downloading $NAME from $BACKUP_DEST"
  rclone copyto "$BACKUP_DEST/$NAME" "$WORK/$NAME"
  FILE="$WORK/$NAME"
fi
gzip -t "$FILE" || die "$FILE is not a valid gzip file"

if [[ "$YES" != true ]]; then
  echo "This REPLACES database '$PG_DB' with $(basename "$FILE")."
  read -r -p 'Type RESTORE to continue: ' answer
  [[ "$answer" == "RESTORE" ]] || die "cancelled"
fi

# ---- 2. Safety copy of what is there now ----
log "saving a safety dump of the current database"
"$(dirname "${BASH_SOURCE[0]}")/backup-db.sh" --local-only || log "warning: safety dump failed (empty database?)"

# ---- 3. Restore ----
if [[ "${PG_MODE:-compose}" != "native" ]]; then
  log "stopping api and worker"
  compose stop api worker
fi

log "recreating database '$PG_DB'"
pg_tool psql --username="$PG_USER" --dbname=postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$PG_DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$PG_DB\";"

log "loading $(basename "$FILE")"
gunzip -c "$FILE" | pg_tool psql --username="$PG_USER" --dbname="$PG_DB" \
  -v ON_ERROR_STOP=1 --single-transaction --quiet >/dev/null

# ---- 4. Migrate and start ----
if [[ "${PG_MODE:-compose}" != "native" ]]; then
  log "applying migrations and starting api + worker"
  compose run --rm migrate
  compose up -d api worker
fi
log "restore finished"
