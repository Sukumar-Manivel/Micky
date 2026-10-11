#!/usr/bin/env bash
# `cond && pass || fail` is safe in this file: pass always succeeds and fail exits.
# shellcheck disable=SC2015
# Local end-to-end test of the backup scripts: encrypt -> "upload" -> restore, for the
# database and for media, plus the failure cases. Runs against a scratch database on a local
# PostgreSQL (no Docker) and a folder standing in for R2. Run with: make test-backups
#
# Needs: psql/pg_dump on PATH, age, rclone, and a role that can create databases
# (default postgresql://micky:micky@localhost:5432). The scratch DB is dropped at the end.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-micky}" PGPASSWORD="${PGPASSWORD:-micky}"
DB="micky_backup_test_$$"
T="$(mktemp -d)"
cleanup() {
  psql -d postgres -qc "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; exit 1; }

mkdir -p "$T/ff" "$T/remote/postgres" "$T/local" "$T/media/originals/m1" "$T/restored"
age-keygen -o "$T/key.txt" 2>"$T/pub.txt"
age-keygen -o "$T/wrong.txt" 2>/dev/null
PUB="$(grep -o 'age1[0-9a-z]*' "$T/pub.txt")"
printf 'POSTGRES_USER=%s\nPOSTGRES_DB=%s\nBACKUP_AGE_RECIPIENTS=%s\n' "$PGUSER" "$DB" "$PUB" >"$T/ff/.env"
export PG_MODE=native MEDIA_MODE=native FF_DIR="$T/ff" BACKUP_DIR="$T/local" BACKUP_DEST="$T/remote/postgres"

psql -d postgres -qc "CREATE DATABASE \"$DB\"" >/dev/null
psql -d "$DB" -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE media (id text PRIMARY KEY, original_key text NOT NULL, size_bytes int NOT NULL,
  status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE orders (media_id text, status text);
CREATE TABLE users (email text);
INSERT INTO users VALUES ('witness@example.in');
INSERT INTO media VALUES ('m1', 'originals/m1/source.mp4', 300000, 'APPROVED');
INSERT INTO orders VALUES ('m1', 'PAID');
SQL
head -c 300000 /dev/urandom >"$T/media/originals/m1/source.mp4"

# ---- database ----
"$HERE/backup-db.sh" >/dev/null 2>&1 || fail "backup-db.sh"
dump="$(ls "$T/remote/postgres"/micky-*.sql.gz.age)"
head -c 21 "$dump" | grep -q '^age-encryption.org/v1' && pass "database dump is an age file" || fail "dump not encrypted"
if gunzip -c "$dump" >/dev/null 2>&1 || grep -aq 'witness@example.in' "$dump"; then fail "plaintext visible"; else pass "no plaintext in the dump"; fi

(unset BACKUP_AGE_RECIPIENTS; sed -i '/BACKUP_AGE_RECIPIENTS/d' "$T/ff/.env"; "$HERE/backup-db.sh" >/dev/null 2>&1) &&
  fail "backup without a public key should refuse" || pass "refuses to back up without a public key"
printf 'BACKUP_AGE_RECIPIENTS=%s\n' "$PUB" >>"$T/ff/.env"

psql -d "$DB" -qc "DELETE FROM users" >/dev/null
"$HERE/restore-db.sh" latest --yes >/dev/null 2>&1 && fail "restore without key" || pass "restore without the private key refuses"
"$HERE/restore-db.sh" latest --yes --identity "$T/wrong.txt" >/dev/null 2>&1 && fail "restore with wrong key" || pass "restore with the wrong key refuses"
[[ "$(psql -d "$DB" -tAc 'SELECT count(*) FROM users')" == 0 ]] && pass "a refused restore leaves the database alone" || fail "database touched"
"$HERE/restore-db.sh" latest --yes --identity "$T/key.txt" >/dev/null 2>&1 || fail "restore-db.sh"
[[ "$(psql -d "$DB" -tAc 'SELECT email FROM users')" == witness@example.in ]] && pass "database round trip" || fail "data not restored"

# ---- media ----
MEDIA_DIR="$T/restored" "$HERE/backup-media.sh" >/dev/null 2>&1 && fail "missing file should fail" || pass "an unreadable original fails the run"
[[ ! -e "$T/remote/media/originals/m1/source.mp4.age" ]] && pass "no truncated object left under the final name" || fail "partial upload kept"
MEDIA_DIR="$T/media" "$HERE/backup-media.sh" >/dev/null 2>&1 || fail "backup-media.sh"
grep -q '^age-encryption.org/v1' <(head -c 21 "$T/remote/media/originals/m1/source.mp4.age") && pass "media object is an age file" || fail "media not encrypted"
MEDIA_DIR="$T/restored" "$HERE/restore-media.sh" --identity "$T/key.txt" >/dev/null 2>&1 || fail "restore-media.sh"
cmp -s "$T/media/originals/m1/source.mp4" "$T/restored/originals/m1/source.mp4" && pass "media round trip (byte-identical)" || fail "media differs"
BACKUP_MEDIA_MAX_GB=0 MEDIA_DIR="$T/media" "$HERE/backup-media.sh" --scope all >/dev/null 2>&1 && fail "size cap" || pass "size cap stops the upload"
(unset PGPASSWORD; export PGPASSFILE=/dev/null PGPASSWORD=wrong; MEDIA_DIR="$T/media" "$HERE/backup-media.sh" >/dev/null 2>&1) &&
  fail "db error should fail" || pass "a database error fails the run instead of backing up nothing"

echo "all backup tests passed ($ROOT)"
