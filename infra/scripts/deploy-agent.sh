#!/usr/bin/env bash
# Deploy the Postal provisioning agent to Box B.
#
# Separate from deploy.sh because it runs on a different machine and restarts
# a different service. Run it ON Box B.
#
#   sudo /opt/mailkong-agent/deploy-agent.sh /path/to/checkout

set -euo pipefail

SRC="${1:-}"
DEST="${DEST:-/opt/mailkong-agent}"

[[ -d "$SRC/infra/postal-agent" ]] || {
  echo "usage: deploy-agent.sh <path-to-mailkong-checkout>" >&2
  exit 1
}

[[ -f /etc/mailkong/agent.env ]] || {
  echo "ERROR: /etc/mailkong/agent.env is missing." >&2
  echo "Create it first — see infra/postal-agent/README.md." >&2
  exit 1
}

install -d -o postal -g postal "$DEST"
install -o postal -g postal -m 640 "$SRC/infra/postal-agent/agent.rb" "$DEST/agent.rb"
install -o postal -g postal -m 640 "$SRC/infra/postal-agent/Gemfile" "$DEST/Gemfile"

# Syntax-check before restarting: a typo here takes provisioning down, and
# provisioning failing is how signups start failing.
ruby -c "$DEST/agent.rb"

sudo -u postal bash -c "cd '$DEST' && bundle install --quiet"

install -m 644 "$SRC/infra/postal-agent/mailkong-agent.service" /etc/systemd/system/
systemctl daemon-reload
systemctl restart mailkong-agent

for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 localhost:5000/health >/dev/null 2>&1; then
    echo "agent healthy"
    exit 0
  fi
  sleep 1
done

echo "ERROR: the agent did not come up. journalctl -u mailkong-agent -n 50" >&2
exit 1
