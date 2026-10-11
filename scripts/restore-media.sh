#!/usr/bin/env bash
# Restores originals backed up by backup-media.sh (for example after losing the VM's disk).
#
#   scripts/restore-media.sh --identity ~/backup-key.txt            # every missing original
#   scripts/restore-media.sh --identity ~/backup-key.txt --overwrite # also replace existing files
#
# Files are downloaded from R2, decrypted with the age PRIVATE key (kept off the server; copy it
# up for this and `shred -u` it afterwards) and written into the media volume. Files that are
# already present are left alone unless --overwrite is given. Restore the database first
# (restore-db.sh), so the media rows exist; previews can then be rebuilt by the worker.
# MEDIA_MODE=native + MEDIA_DIR=/path writes to a plain folder (testing, non-Docker).
set -euo pipefail
umask 077

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

IDENTITY=""
OVERWRITE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity | -i)
      [[ $# -ge 2 ]] || die "--identity needs a file"
      IDENTITY="$2"
      shift 2
      ;;
    --overwrite) OVERWRITE=true; shift ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
KEY="$(age_identity_file "$IDENTITY")"
MEDIA_DIR="${MEDIA_DIR:-/data/storage}"

# Is the file there already? / Write stdin to the file (in the api container's volume).
media_exists() {
  if [[ "${MEDIA_MODE:-compose}" == "native" ]]; then
    [[ -s "$MEDIA_DIR/$1" ]]
  else
    compose exec -T api test -s "$MEDIA_DIR/$1" </dev/null
  fi
}
write_media() {
  if [[ "${MEDIA_MODE:-compose}" == "native" ]]; then
    mkdir -p "$(dirname "$MEDIA_DIR/$1")" && cat >"$MEDIA_DIR/$1.restoring" && mv "$MEDIA_DIR/$1.restoring" "$MEDIA_DIR/$1"
  else
    # The path is passed as an argument ($1 inside), not pasted into the shell code.
    # shellcheck disable=SC2016
    compose exec -T api sh -c 'mkdir -p "$(dirname "$1")" && cat >"$1.restoring" && mv "$1.restoring" "$1"' sh "$MEDIA_DIR/$1"
  fi
}

setup_rclone
MEDIA_DEST="${MEDIA_DEST:-${BACKUP_DEST%/postgres}/media}"
restored=0 skipped=0 failed=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Read the whole list first: `docker compose exec` inside the loop would otherwise eat stdin.
listing="$(rclone lsf -R --files-only "$MEDIA_DEST")" || die "could not list $MEDIA_DEST"
NAMES=()
[[ -z "$listing" ]] || mapfile -t NAMES <<<"$listing"
for name in "${NAMES[@]}"; do
  [[ "$name" == *.age ]] || continue
  key="${name%.age}"
  [[ "$key" =~ ^originals/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$ && "$key" != *..* ]] || {
    log "skipping unexpected object: $name"
    continue
  }
  if [[ "$OVERWRITE" != true ]] && media_exists "$key"; then
    skipped=$((skipped + 1))
    continue
  fi
  # Download, then decrypt fully before writing: age authenticates the data, so a damaged
  # object fails here instead of leaving a half-written original behind.
  if rclone copyto "$MEDIA_DEST/$name" "$WORK/obj.age" &&
    age --decrypt --identity "$KEY" --output "$WORK/obj" "$WORK/obj.age" &&
    write_media "$key" <"$WORK/obj"; then
    restored=$((restored + 1))
    log "restored $key"
  else
    failed=$((failed + 1))
    log "ERROR: could not restore $key"
  fi
  rm -f "$WORK/obj" "$WORK/obj.age"
done

log "restored $restored, already present $skipped, failed $failed"
log "now remove the private key from this server: shred -u '$KEY'"
((failed == 0))
