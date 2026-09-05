#!/usr/bin/env bash
# Restore a backup taken by backup.sh.
#
# Test this before you need it. An untested restore is a hope, not a backup.
#
#   ./restore.sh /var/backups/mailkong/mailkong-20260905T031700Z.sql.gz

set -euo pipefail

dump="${1:-}"
[[ -f "$dump" ]] || { echo "usage: restore.sh <dump.sql.gz>" >&2; exit 1; }

ENV_FILE="${ENV_FILE:-/opt/mailkong/.env}"
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"

echo "This REPLACES the contents of:"
echo "  ${DATABASE_URL%%\?*}"
read -r -p "Type the word RESTORE to continue: " confirm
[[ "$confirm" == "RESTORE" ]] || { echo "aborted"; exit 1; }

echo "Stopping services so nothing writes during the restore..."
systemctl stop mailkong mailkong-worker || true

gunzip -c "$dump" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1

echo "Applying any migrations newer than the dump..."
cd /opt/mailkong && npm run db:deploy

systemctl start mailkong mailkong-worker
echo "Restored. Check https://api.mailkong.net/health"
