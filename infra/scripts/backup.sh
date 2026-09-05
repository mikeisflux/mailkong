#!/usr/bin/env bash
# Nightly backup of the control plane database.
#
# The control-plane DB is the source of truth for accounts, plans, invoices,
# credentials and suppressions. Postal holds the message bodies and has its
# own MariaDB; back that up separately on Box B.
#
# Install on Box A:
#   sudo cp backup.sh /usr/local/bin/mailkong-backup
#   sudo chmod +x /usr/local/bin/mailkong-backup
#   ( crontab -l 2>/dev/null; echo "17 3 * * * /usr/local/bin/mailkong-backup" ) | crontab -

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/mailkong}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
ENV_FILE="${ENV_FILE:-/opt/mailkong/.env}"

[[ -f "$ENV_FILE" ]] || { echo "no env file at $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
[[ -n "$DATABASE_URL" ]] || { echo "DATABASE_URL not set" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/mailkong-$stamp.sql.gz"

# --clean --if-exists so the dump can be restored over an existing database
# without hand-editing it at 3am.
pg_dump --no-owner --no-privileges --clean --if-exists "$DATABASE_URL" | gzip -9 > "$out.partial"

# Only name it as a real backup once it completed, so a truncated dump from a
# failed run can never be mistaken for a good one.
mv "$out.partial" "$out"
chmod 600 "$out"

# A dump that cannot be read is not a backup.
if ! gzip -t "$out"; then
  echo "backup $out failed integrity check" >&2
  exit 1
fi

find "$BACKUP_DIR" -name 'mailkong-*.sql.gz' -mtime "+$RETAIN_DAYS" -delete
find "$BACKUP_DIR" -name '*.partial' -mtime +1 -delete

size="$(du -h "$out" | cut -f1)"
echo "backup ok: $out ($size)"

# Off-box copy. Local backups do not survive losing the box, which is the
# case they exist for. Configure one of these and delete this notice.
if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rsync -a --chmod=600 "$out" "$BACKUP_REMOTE/" && echo "copied to $BACKUP_REMOTE"
else
  echo "WARNING: BACKUP_REMOTE is not set; this backup exists only on this box." >&2
fi
