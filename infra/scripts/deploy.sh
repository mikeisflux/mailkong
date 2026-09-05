#!/usr/bin/env bash
# Deploy the control plane to Box A.
#
# Run it ON Box A, as the deploy user:
#   /opt/mailkong/infra/scripts/deploy.sh [git-ref]
#
# Or from your machine:
#   ssh deploy@app.mailkong.net /opt/mailkong/infra/scripts/deploy.sh main
#
# The whole thing is idempotent and safe to re-run. It refuses to start a
# deploy it cannot finish, and rolls the release back if the new version does
# not answer its health check.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/mailkong}"
REF="${1:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

cd "$APP_DIR"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- preflight

say "Preflight"

[[ -f .env ]] || fail ".env is missing. Copy .env.example and fill it in."

# A half-configured deploy that starts and then fails on the first request is
# worse than one that refuses to start.
for key in DATABASE_URL REDIS_URL SESSION_SECRET ENCRYPTION_KEY POSTAL_API_URL; do
  grep -qE "^${key}=.+" .env || fail "$key is empty in .env"
done

command -v node >/dev/null || fail "node is not installed"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || fail "node 22 or newer required, found $(node -v)"

if [[ -n "$(git status --porcelain)" ]]; then
  fail "working tree is dirty. Commit or stash before deploying."
fi

previous="$(git rev-parse HEAD)"
echo "current release: ${previous:0:8}"

# ------------------------------------------------------------------ fetch

say "Fetching $REF"
git fetch --prune origin
git checkout --quiet "$REF"
git reset --hard --quiet "origin/$REF" 2>/dev/null || git reset --hard --quiet "$REF"
target="$(git rev-parse HEAD)"

if [[ "$target" == "$previous" ]]; then
  echo "already at ${target:0:8}; continuing anyway to pick up dependency or schema changes"
fi
echo "deploying: ${target:0:8} $(git log -1 --pretty=%s)"

# ------------------------------------------------------------------ build

say "Installing dependencies"
npm ci --omit=dev --no-audit --no-fund
# The Prisma CLI and TypeScript live in devDependencies but are needed to
# build and migrate, so bring them in for the duration of the deploy.
npm install --no-save --no-audit --no-fund prisma typescript

say "Generating the database client"
npx prisma generate

# A backup immediately before migrating is the only thing that makes a bad
# migration recoverable.
if command -v pg_dump >/dev/null && [[ -x infra/scripts/backup.sh ]]; then
  say "Backing up before migrating"
  ./infra/scripts/backup.sh || fail "pre-migration backup failed; refusing to migrate"
fi

say "Applying migrations"
# `migrate deploy` never resets and never generates: it applies pending
# migrations or fails. Anything interactive has no place in a deploy.
npx prisma migrate deploy

say "Building"
npx tsc -p tsconfig.json

for app in dashboard admin; do
  say "Building web/$app"
  npm --prefix "web/$app" ci --no-audit --no-fund
  npm --prefix "web/$app" run build
done

say "Regenerating the API reference"
npm run docs:api || echo "(skipped)"

# ---------------------------------------------------------------- restart

say "Restarting services"
sudo systemctl restart mailkong mailkong-worker

# ------------------------------------------------------------ health gate

say "Waiting for health"
deadline=$(( SECONDS + HEALTH_TIMEOUT ))
healthy=false

while (( SECONDS < deadline )); do
  if body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
    if grep -q '"ok":true' <<<"$body"; then
      healthy=true
      echo "$body"
      break
    fi
    echo "not ready yet: $body"
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  say "Health check failed — rolling back to ${previous:0:8}"
  git reset --hard --quiet "$previous"
  npm ci --omit=dev --no-audit --no-fund
  npx prisma generate
  npx tsc -p tsconfig.json
  sudo systemctl restart mailkong mailkong-worker
  fail "deploy rolled back. Migrations are NOT reverted — check them by hand if the schema changed."
fi

# ---------------------------------------------------------------- verify

say "Verifying the worker"
if systemctl is-active --quiet mailkong-worker; then
  echo "worker: running"
else
  echo "WARNING: the worker is not running. Domains will never verify, webhooks" >&2
  echo "will never be delivered, and the automatic pause will never fire." >&2
fi

say "Deployed ${target:0:8}"
git log -1 --pretty='  %h %s%n  by %an, %ar'
