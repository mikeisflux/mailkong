# Postal provisioning agent

## Why it exists

Postal's official HTTP API covers **sending and message queries only** —
`/api/v1/send/message`, `/api/v1/send/raw`, `/api/v1/messages/*`, each
authenticated per mail server with `X-Server-API-Key`.

Creating organizations, mail servers, domains, credentials, routes and IP
pools — everything the platform spec's section 11 depends on — is **not in
that API**. Postal expects those to be done through its web UI.

This agent closes that gap by loading Postal's own Rails environment and
calling the same models the UI does. It is the single place where that
coupling lives; `src/postal/admin.ts` talks only to this HTTP surface, so if
Postal ever ships a first-party management API, only the transport changes.

## What was rejected, and why

**Writing to Postal's MariaDB directly.** Bypasses ActiveRecord callbacks —
including DKIM keypair generation — and breaks on any Postal schema change.

**Shelling out to `postal console` per call.** A Rails boot per request, with
shell quoting as the security boundary.

## Install

On Box B, after Postal is running:

```bash
sudo mkdir -p /opt/mailkong-agent /etc/mailkong
sudo cp agent.rb Gemfile /opt/mailkong-agent/
cd /opt/mailkong-agent && sudo -u postal bundle install

# The shared token. This exact value goes in the control plane's
# POSTAL_API_KEY on Box A.
printf 'AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)" | sudo tee /etc/mailkong/agent.env
sudo chmod 600 /etc/mailkong/agent.env

sudo cp mailkong-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mailkong-agent
curl -s localhost:5000/health
```

## Exposing it to Box A

The agent binds to **127.0.0.1 only**. Publish it through the reverse proxy
that already fronts Postal, under `/_agent`, restricted to Box A's address:

```nginx
location /_agent/ {
    allow  <BOX_A_IP>;
    deny   all;
    proxy_pass http://127.0.0.1:5000/;
    proxy_set_header Host $host;
}
```

The control plane calls `${POSTAL_API_URL}/_agent/v1/...`, so the proxy must
strip `/v1` or the agent must be mounted to match — the `proxy_pass` above
with a trailing slash sends `/_agent/v1/organizations` through as
`/v1/organizations`. Add `map` or adjust the route prefixes if your proxy
differs; the agent's routes have no `/v1` prefix of their own.

## Security

- Bearer token compared with `OpenSSL.secure_compare`, so it cannot be
  recovered by timing.
- Loopback bind plus an IP-restricted proxy: two independent controls.
- systemd hardening (`ProtectSystem=strict`, `NoNewPrivileges`) because this
  process can destroy customer mail objects.
- The token is the same secret as `POSTAL_API_KEY` on Box A. Rotating it means
  changing both and restarting both.

## Compatibility

Written against Postal 3.x model names: `Organization`, `Server`, `Domain`,
`Credential`, `Route`, `HTTPEndpoint`, `IPPool`, `IPAddress`, `QueuedMessage`,
`Worker`. If a Postal upgrade renames any of these, this file is the only
thing that needs to change.

Verify after any Postal upgrade:

```bash
curl -s -H "Authorization: Bearer $AGENT_TOKEN" localhost:5000/health/queue
```
