# Mailkong

Self-hosted transactional email platform. Postal is the mail engine; this is
the product around it — customer dashboard, admin console, public API, and the
marketing site.

```
Internet / customer apps
        │
        ├── HTTPS  api.mailkong.net      send API, inbound webhooks out
        ├── SMTP   smtp.mailkong.net     :587 STARTTLS
        ├── HTTPS  app.mailkong.net      customer dashboard
        └── HTTPS  admin.mailkong.net    operator console
                    │
                    ▼
            Control plane (this repo)
            auth, billing, quotas, provisioning
                    │
                    ▼
                 Postal
            orgs / servers / domains / routes / IP pools
                    │
                    ▼
              Sending IPs  →  recipient MX
```

## Layout

| Path | What |
|---|---|
| `src/` | Control plane — Fastify, Prisma, BullMQ |
| `src/api/v1/` | Public API (`docs/openapi.yaml`) |
| `src/app/` | Customer dashboard backend |
| `src/admin/` | Admin console backend |
| `src/postal/` | Postal clients — send API, and the provisioning agent |
| `src/services/` | The rules: quotas, domains, send pipeline, events |
| `src/jobs/` | DNS sweep, webhook delivery, usage, policy, retention |
| `src/mail/` | Platform's own email — sent through the internal tenant |
| `web/site/` | Marketing site (static HTML) |
| `web/docs/` | Documentation + API reference |
| `web/status/` | Status page (self-contained, host it elsewhere) |
| `web/dashboard/` | Customer dashboard (React) |
| `web/admin/` | Admin console (React) |
| `infra/postal-agent/` | Provisioning agent that runs on Box B |
| `infra/dns/` | Platform DNS zone |
| `infra/scripts/` | Backup and restore |
| `docs/` | Infrastructure decisions, runbook, OpenAPI |

## Running it locally

```bash
npm install
cp .env.example .env      # fill SESSION_SECRET and ENCRYPTION_KEY
docker compose up -d      # Postgres + Redis
npm run db:migrate
npm run db:seed           # plans, feature flags, shared-tx pool
npx tsx prisma/dev-seed.ts  # a populated tenant, without needing Postal

npm run dev                            # control plane   :3000
npm run worker                         # background jobs
npm --prefix web/dashboard run dev     # dashboard       :5173
npm --prefix web/admin run dev         # admin           :5174
```

The dev fixture signs in as `dev@mailkong.net` / `devpassword1234`.

```bash
npm test          # 43 tests: the send pipeline and every auth token flow,
                  # against real Postgres and Redis with Postal stubbed
npm run typecheck
npm run docs:api  # regenerate web/docs/openapi.json from docs/openapi.yaml
```

## The one thing to know before reading the code

**Postal's HTTP API only covers sending and message queries.** Creating
organizations, servers, domains, credentials and IP pools is not exposed over
HTTP — Postal expects that through its web UI.

So the Postal integration is split in two:

- `src/postal/client.ts` — the real `/api/v1` send and message endpoints.
- `src/postal/admin.ts` — provisioning, which talks to a companion agent
  (`infra/postal-agent/`) that loads Postal's own Rails environment and calls
  the same models its UI does.

Writing to Postal's MariaDB directly was rejected: it bypasses the callbacks
that generate DKIM keypairs, and breaks on any Postal upgrade.

## Deployment

Two boxes, per `docs/infrastructure.md`:

- **Box A** — control plane, Postgres, Redis, nginx. Never sends mail.
- **Box B** — Postal, MariaDB, RabbitMQ, the provisioning agent. Sending IPs
  bind here.

`docs/runbook-phase0.md` takes both from bare Ubuntu to a verified first
message, including the PTR ordering that OVH enforces and the Postal webhook
without which nothing ever leaves `queued`.

## Documents

| File | What it settles |
|---|---|
| `docs/infrastructure.md` | Why OVH, which plans, which datacenter, which OS, and when to migrate off |
| `docs/ovh-support-request.md` | The pre-purchase ticket, and what each answer means |
| `docs/runbook-phase0.md` | Bare Ubuntu → first verified message |
| `docs/openapi.yaml` | Public API reference |
| `infra/postal-agent/README.md` | Why the agent exists and how to install it |

## The internal tenant is load-bearing

The platform sends its own email — verification, invites, resets, and every
alert — through the `internal` tenant's Postal server. That is spec 14's point:
our mail travels the path our customers' does, so an outage here is one we feel
before they report it.

Until that tenant exists and has a verified domain, platform email is logged
rather than sent. Signup still works; the confirmation email just does not
arrive. **Finish step 10 of the Phase 0 runbook before onboarding anyone.**

## Status

Phases 0–3 of the spec are implemented. Before public signup:

- [ ] OVH port 25 request answered
- [ ] Both boxes provisioned per the runbook
- [ ] Internal tenant sending real mail with SPF, DKIM and DMARC passing
- [ ] An operator has enrolled TOTP at `admin.mailkong.net`
- [ ] Stripe products created and `stripe_price_id` set on each plan
- [ ] `BACKUP_REMOTE` configured, and a restore rehearsed
- [ ] Terms and privacy pages reviewed by a lawyer
- [ ] `signup_open` still off until pause and search are exercised in anger
