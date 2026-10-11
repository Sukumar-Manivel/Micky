#!/usr/bin/env bash
# Restores the PostgreSQL database from a backup made by backup-db.sh.
#
#   scripts/restore-db.sh --list                                   # backups in R2 and on disk
#   scripts/restore-db.sh latest --identity ~/backup-key.txt       # newest backup in R2
#   scripts/restore-db.sh micky-20261011T023000Z.sql.gz.age --identity ~/backup-key.txt
#   scripts/restore-db.sh /var/backups/micky/micky-....sql.gz.age --identity ...
#   add --yes to skip the confirmation prompt
#
# Backups are age-encrypted; --identity (or BACKUP_AGE_IDENTITY) is the PRIVATE key that is
# normally kept off the server. Copy it up for the restore and delete it afterwards
# (shred -u ~/backup-key.txt). Old unencrypted *.sql.gz dumps are still accepted.
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
IDENTITY=""
while [[ $# -gt 0 ]]; do
  arg="$1"
  shift
  case "$arg" in
    --yes | -y) YES=true ;;
    --list) SOURCE="--list" ;;
    --identity | -i)
      [[ $# -gt 0 ]] || die "--identity needs a file"
      IDENTITY="$1"
      shift
      ;;
    -h | --help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *) SOURCE="$arg" ;;
  esac
done
[[ -n "$SOURCE" ]] || die "usage: $0 <latest | backup-file-name | /path/to/file.sql.gz | --list> [--yes]"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/micky}"
PG_USER="$(env_get POSTGRES_USER micky)"
PG_DB="$(env_get POSTGRES_DB micky)"
[[ "$PG_DB" =~ ^[A-Za-z0-9_]+$ ]] || die "POSTGRES_DB must be letters, digits and _ only"

if [[ "$SOURCE" == "--list" ]]; then
  setup_rclone
  echo "== Remote ($BACKUP_DEST)"
  rclone lsl "$BACKUP_DEST" --include 'micky-*.sql.gz*' | sort -k2,3 || true
  echo "== Local ($BACKUP_DIR)"
  ls -lh "$BACKUP_DIR"/micky-*.sql.gz* 2>/dev/null || echo "(none)"
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
    # Sorted by the timestamp in the name; encrypted and old plain dumps sort together.
    NAME="$(rclone lsf "$BACKUP_DEST" --include 'micky-*.sql.gz*' | sort | tail -n 1)"
    [[ -n "$NAME" ]] || die "no backups found in $BACKUP_DEST"
  fi
  [[ "$NAME" =~ ^micky-[0-9TZ]+\.sql\.gz(\.age)?$ ]] || die "not a backup file name: $NAME"
  log "downloading $NAME from $BACKUP_DEST"
  rclone copyto "$BACKUP_DEST/$NAME" "$WORK/$NAME"
  FILE="$WORK/$NAME"
fi
# Decrypt into the private temp folder (umask 077, removed on exit) and check it is intact
# BEFORE touching the live database. age authenticates the data: a corrupted or tampered file
# fails here, not halfway through the restore.
if [[ "$FILE" == *.age ]]; then
  KEY="$(age_identity_file "$IDENTITY")"
  log "decrypting $(basename "$FILE")"
  age --decrypt --identity "$KEY" --output "$WORK/restore.sql.gz" "$FILE" || die "could not decrypt $FILE with $KEY"
  PLAIN="$WORK/restore.sql.gz"
else
  log "warning: $(basename "$FILE") is an old UNENCRYPTED dump"
  PLAIN="$FILE"
fi
gzip -t "$PLAIN" || die "$FILE does not contain a valid gzip file"

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
gunzip -c "$PLAIN" | pg_tool psql --username="$PG_USER" --dbname="$PG_DB" \
  -v ON_ERROR_STOP=1 --single-transaction --quiet >/dev/null

# ---- 4. Migrate and start ----
if [[ "${PG_MODE:-compose}" != "native" ]]; then
  log "applying migrations and starting api + worker"
  compose run --rm migrate
  compose up -d api worker
fi
log "restore finished"
if [[ -n "$IDENTITY" ]]; then
  log "now remove the private key from this server: shred -u '$IDENTITY'"
fi
