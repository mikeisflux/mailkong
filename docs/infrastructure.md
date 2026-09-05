# Infrastructure decision record

Server, hosting, and OS decisions for the mail platform described in the
platform spec. Written before Phase 0. Revisit at each phase boundary.

---

## 1. The constraint that drives everything

Postal is a light workload. CPU and RAM are not the deciding factors. The
host must be able to:

1. **Send outbound on port 25.** Most clouds block this permanently.
2. **Set PTR / reverse DNS per IP.** The spec requires
   `SEND_IP_1 -> mta1.mailkong.net`.
3. **Sell additional IPv4 addresses.** Two for `shared-tx` on day one, plus
   one per dedicated-IP customer.
4. **Tolerate an email platform** without terminating the account the first
   time a tenant sends something a filter dislikes.

Requirement 1 eliminates AWS, GCP, Azure, DigitalOcean, Linode, Scaleway,
and Oracle Cloud. Requirement 4 eliminates most of what is left.

---

## 2. Host: OVHcloud

Chosen because it satisfies all four, sells IPv4 at a sane price, and exposes
PTR editing as self-service in the control panel.

### Which OVH

OVHcloud US (`us.ovhcloud.com`) and OVHcloud EU/CA (`ovhcloud.com`) are
**separate legal entities** with separate accounts, catalogs, billing, and IP
allocations. Servers cannot be moved between them.

| | OVH US | OVH EU/CA |
|---|---|---|
| Datacenters | Vint Hill VA, Hillsboro OR | Gravelines/Roubaix FR, Beauharnois CA |
| IP registry | ARIN, US-geolocated | RIPE (BHS is ARIN) |
| Catalog | Thinner | Full range |

**Decision: OVH US.** US-geolocated IPs matter for placement into Gmail and
Microsoft, and for customer trust about where their mail originates.
Beauharnois on the EU account is an acceptable fallback.

### Datacenter: Vint Hill (US - East)

Available North America locations at time of writing: Hillsboro (US West),
Vint Hill (US East), Seattle (LocalZone), and Beauharnois (Canada East), all
at the same price.

**Vint Hill** is chosen for proximity to the Ashburn peering complex in
Northern Virginia — the densest interconnection point on the internet, and
the shortest path to Google, Microsoft, and Yahoo inbound MX. It is also
closest to the roughly two thirds of the US population in Eastern and Central
time zones.

Rejected:

- **Seattle (LocalZone)** — LocalZones are reduced-catalog edge deployments.
  Additional IP availability is precisely the kind of service likely to be
  limited or absent there, and additional IPs with editable PTR are the
  entire reason for choosing OVH.
- **Beauharnois** — good infrastructure, but Canadian-geolocated IP space
  creates needless friction with filters and with customers asking where
  their mail originates.
- **Hillsboro** — viable, but West Coast. Choose only if the customer base
  skews Pacific.

**Both boxes go in the same datacenter.** The control plane sits in the path
of every send: authenticate, check caps, check suppressions, then call
Postal's API — plus the two-minute DNS verification cron and webhook fan-out.
Same-DC is a sub-millisecond hop; Vint Hill to Hillsboro would add roughly
60-70ms to every message sent, permanently, for no benefit.

### Port 25 is blocked by default

Per OVH's current support documentation, outbound port 25 is blocked by
default across OVHcloud infrastructure — dedicated servers, VPS, and Public
Cloud alike — and is unblocked by support request. OVH additionally runs
automated outbound SMTP monitoring: traffic flagged as spam results in a
network-level block of the SMTP port, with escalating duration on repeat.

Consequences:

- **The port 25 support request is a gating step, not a follow-up.** Open it
  before building Box B, and ideally before ordering it.
- The product rules in the spec's signup-and-sending-policy section
  (`paused_pending_domain` on signup, low starting daily cap, verified
  from-domain enforcement, auto-suppress on hard bounce, auto-pause on
  bounce/complaint spike) are not deliverability hygiene here. They are what
  keeps the port open.
- The abuse mailbox must be read. OVH forwards complaints to the account
  holder and escalates when ignored.

---

## 3. Product: OVH VPS 2027 range

The Eco range (Kimsufi / So You Start / Rise) was rejected: additional IPv4
is restricted or unavailable on that hardware, and the platform needs three
or more routable IPs on the mail box from day one.

VPS was chosen over Advance dedicated because port 25 policy is now identical
between them, removing dedicated's main advantage, and the price difference
is roughly 3x.

### Allocation

| Box | Role | Plan | Specs | $/mo |
|---|---|---|---|---|
| **A** | Control plane | VPS-2 | 4 vCore, 8 GB, 75 GB NVMe | 8.50 |
| **B** | Postal | VPS-4 | 8 vCore, 24 GB, 200 GB NVMe | 23.37 |
| | | | **Total** | **31.87** |

Both include daily backup of the previous 24 hours.

**Box A** runs the customer dashboard, admin console, public API, reverse
proxy, Postgres, Redis, and Stripe webhooks. It never sends mail, so none of
the section 1 constraints apply to it. At 1M sends/month the API sees roughly
25 requests/minute average; 4 vCore / 8 GB is generous.

**Box B** runs Postal only — Ruby/Puma, workers, SMTP server, MariaDB,
RabbitMQ. Sending IPs bind here. Nothing else public except SMTP 25/587 and
inbound 25.

Bandwidth tiers across the VPS range (500 Mbps to 3 Gbps) are irrelevant to
this workload and were not a factor.

### Disk is the binding constraint

Postal stores full message bodies in MariaDB, and the plan tiers sell 7 /
30 / 90-day retention. At roughly 50 KB per message including headers and
HTML:

| Disk | 7-day retention | 30-day | 90-day |
|---|---|---|---|
| 100 GB (VPS-3) | ~8M/mo | ~2M/mo | ~650k/mo |
| 200 GB (VPS-4) | ~17M/mo | ~4M/mo | ~1.3M/mo |

VPS-3 would begin squeezing as soon as the first 90-day Pro plan sells. The
extra $11/mo for VPS-4 buys roughly a year of not thinking about it.

### Pricing caveat

The advertised figures are commitment pricing (12 or 24 month). Month-to-month
costs materially more — VPS-2 advertised at $8.50 prices at $10.00/mo with no
commitment, an 18% premium. Budget roughly **$38/mo** for both boxes at no
commitment rather than the $31.87 advertised. **Stay month-to-month on Box B** — a burned IP range
may require walking away from the box. Box A never sends mail and has no
reputation to lose, so a 12-month commitment there is safe.

---

## 4. IP plan

OVH VPS **does not support IP blocks**. Additional IPs are ordered
individually as `/32`, up to **16 per VPS**. Sixteen is sufficient: two for
`shared-tx`, leaving thirteen for dedicated-IP customers.

The tradeoff versus a dedicated server's contiguous `/29`: sending IPs land
in unrelated neighborhoods rather than one block. Since filters weight the
surrounding `/24`, and OVH's VPS pools contain more short-lived and abusive
instances than its dedicated ranges, this costs warmup time and some inbox
placement. It is the main accepted cost of the VPS choice.

### Day-one order

- 2 additional IPv4 on Box B, for the `shared-tx` pool
- US geolocation on each, if offered

### On delivery, before configuring anything

Check every delivered IP against Spamhaus, Barracuda, and SORBS, and inspect
the `/24` neighbors. OVH will generally swap a pre-listed IP if asked
promptly; arguing it a month later is much harder.

### Host configuration

Additional OVH IPs are added as extra addresses on the primary NIC and share
the server's existing gateway:

```yaml
# /etc/netplan/50-cloud-init.yaml
network:
  version: 2
  ethernets:
    ens3:
      addresses:
        - PRIMARY_IP/32
        - SEND_IP_1/32
        - SEND_IP_2/32
      routes:
        - to: default
          via: PRIMARY_GATEWAY
          on-link: true
```

Then create the `shared-tx` pool in Postal and add both sending IPs as
members. Postal binds outbound SMTP to them.

### PTR — order matters

OVH validates that the forward A record already resolves to the IP before it
will accept the PTR.

1. Publish `mta1.mailkong.net A SEND_IP_1`. Confirm with
   `dig +short mta1.mailkong.net`.
2. Control Panel → Network → Public IP Addresses → `...` → Modify the
   reverse → enter the hostname.
3. Verify the loop closes:

```
dig -x SEND_IP_1 +short        # must return mta1.mailkong.net
dig +short mta1.mailkong.net   # must return SEND_IP_1
```

That is forward-confirmed reverse DNS. Gmail and Microsoft defer or reject
without it.

Every fresh OVH server ships with a generic default PTR
(`vpsXXXXXX.vps.ovh.net` or similar). Replace it before any mail leaves the
box — mail sent beforehand is treated as coming from generic hosting.

---

## 5. Operating system: Ubuntu 24.04 LTS

Same OS on both boxes: one set of hardening scripts, one config management
inventory, one thing to patch.

### Why 24.04 and not 26.04

26.04 LTS is available and Docker's official repository supports it, but it
removed the legacy cgroup v1 hierarchy entirely and defaults to containerd
2.x. Those are real changes to the container substrate, and this platform
does not need to be where they get exercised. 24.04 is supported to 2029 —
more runway than the migration horizon in section 7.

### Why Ubuntu and not Debian

Debian (13 in OVH's catalog) works and is arguably the leaner choice; Postal
itself is
indifferent, since everything runs in Docker. The tie-breaker is
documentation alignment: Postal's install guides and effectively all
community troubleshooting are written against Ubuntu. When debugging mail
delivery at 2am, error messages that match the search results are worth more
than a slightly smaller base image.

Rejected outright:

- **Rocky / AlmaLinux** — SELinux and firewalld add friction with Docker
  networking, and Postal is not tested there.
- **Any image with a control panel** (cPanel, Plesk, CyberPanel) — they
  install their own MTA and firewall, which will fight Postal for port 25.

### Install selection

Stock Ubuntu 24.04 server image from OVH's catalog, under "Distribution
only". No control panel, no pre-installed stack. Distribution kernel, not a
vendor kernel.

OVH's image dropdown lists versions without an "LTS" label. This is cosmetic:
Ubuntu's LTS releases are the even-year `.04` ones, so 22.04, 24.04, and
26.04 are all LTS. OVH does not stock the interim `.10` releases. Select
"Version 24.04".

Storage type: **Local storage / High performance**. Do not take
network-attached storage for Box B — MariaDB is fsync-heavy.

Docker comes from Docker's official apt repository, not the distro
`docker.io` package, which lags.

---

## 6. Network exposure

**Box B**

| Port | Exposure |
|---|---|
| 25 | Public — inbound MX for `routes.` and `rp.`, plus outbound |
| 587 | Public — customer SMTP submission |
| 443 (Postal UI) | Allowlisted to operator IPs |
| 22 | Allowlisted, key-only auth |

**Box A**

| Port | Exposure |
|---|---|
| 443 | Public — `app`, `api`, `track` |
| 443 (`admin`) | Allowlisted to operator IPs |
| 22 | Allowlisted, key-only auth |
| Postgres, Redis | Not public |

OVH's Network Firewall is a stateless edge filter and is useful as a coarse
first layer. Do the real work with `nftables` on the host. Leave OVH's
anti-DDoS (VAC) in automatic mode; it handles mail traffic without issue.

### DNS proxying

`mta1`, `mta2`, `rp`, `postal`, and `routes` must be **DNS-only** if the zone
is on Cloudflare. Proxying breaks SMTP and hides the real IP from PTR
validation. `app`, `admin`, `api`, and `track` may be proxied.

---

## 7. When to move off this setup

Migrating Postal later is a MariaDB dump, new IPs, and re-warming — real work
but not dramatic. Treat any of these as the trigger:

- Box B disk crosses ~150 GB
- The first dedicated-IP customer signs, and cares about reputation
- Shared-pool deliverability plateaus and traces to the IP neighborhood
- Volume passes a few million messages/month

The destination at that point is an OVH Advance dedicated server with a
contiguous `/29`, or an equivalent from Hetzner, Interserver, or Hivelocity.
Box A does not need to move.

---

## 8. Order sequence

1. **Box A (VPS-2).** No port 25 dependency. Get it running; establish
   account age and payment history.
2. **Open the port 25 unblock request** for the account. Describe the
   platform accurately: transactional email, SPF/DKIM/DMARC and PTR
   configured, per-tenant caps and auto-suppression enforced. A brand-new
   account with no billing history is the profile most likely to be
   declined — if that happens, let a month of billing accumulate and ask
   again.
3. **Box B (VPS-4)** once the port 25 request has a positive signal.
   Ordering earlier risks paying for a box that cannot do its job.
4. **Additional IPs** on Box B. Blocklist-check on delivery, then A records,
   then PTR.
5. Phase 0 proper: Postal install, platform DNS, internal tenant.

---

## 9. Open items

- Confirm additional IPs are orderable for a VPS in Vint Hill specifically,
  before ordering Box B. The VPS 2027 range is new and this was not verified
  directly. The entire plan rests on this assumption.
- Confirm real month-to-month pricing in the configure step; the advertised
  figures are commitment pricing.
- A third box for `status.mailkong.net` (VPS-1, ~$4.54/mo) is a Phase 3
  item. It must not share infrastructure with what it reports on.
