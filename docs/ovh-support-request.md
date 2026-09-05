# OVHcloud pre-purchase support request

Send this **before ordering anything**. Four things the platform depends on
are not guaranteed by the product page: outbound port 25, additional IPv4 on
VPS in Vint Hill, PTR editing on those IPs, and whether a multi-tenant mail
platform is permitted under the VPS acceptable use policy.

## How to send it

You do not need to buy a service to open a ticket. Create a free OVHcloud US
account, then use **Help → Create a ticket** (pre-sales / technical). If the
form forces you to select an existing service, use the pre-sales contact form
instead.

Ask for the answer **in writing in the ticket**, not by phone. If port 25 is
later blocked by the anti-spam system, a ticket reference showing OVH approved
the use case in advance is the single most useful thing you can have.

Fill in every `{{PLACEHOLDER}}` before sending.

---

## Subject

Pre-sales: outbound port 25, additional IPv4 and rDNS on VPS for a
transactional email platform (Vint Hill)

## Body

Hello,

I am planning to purchase two VPS from OVHcloud and want to confirm that my
intended use is supported before I place the order.

**What I am building**

A self-hosted transactional email platform, using Postal as the mail engine.
It sends application email — password resets, receipts, order notifications,
account alerts — for my own websites initially, and later for a small number
of business customers under my own brand. It is not a marketing or bulk
newsletter product, and I do not send unsolicited mail or use purchased lists.

Expected volume at launch is approximately {{VOLUME}} messages per month,
growing over the first year. Every recipient is a customer or user of the
sending business, receiving mail they triggered or opted into.

**What I plan to purchase**

Both in **North America (US - East - Vint Hill)**, Ubuntu 24.04:

| Role | Model | Specification |
|---|---|---|
| Application server | VPS-2 | 4 vCore, 8 GB RAM, 75 GB NVMe |
| Mail server | VPS-4 | 8 vCore, 24 GB RAM, 200 GB NVMe |

The VPS-2 runs only the web application and database. It does not send mail
and does not need port 25.

The VPS-4 runs Postal and is the only machine that sends. I would want **2
additional IPv4 addresses** on it initially, with the possibility of adding
more later as the platform grows.

**Controls I have in place**

- SPF, DKIM and DMARC configured for every sending domain, and no customer
  may send from a domain until DNS verification passes
- Correct PTR / reverse DNS on every sending IP, forward-confirmed
- Per-customer daily and monthly sending limits, enforced in the application
  before mail reaches Postal
- Automatic suppression of hard bounces and complaints, with automatic
  suspension of any account showing a bounce or complaint spike
- A monitored `abuse@` address, and a documented process for handling
  complaints and feedback loop reports promptly
- Gradual IP warm-up rather than sending at volume from new addresses

**My questions**

1. Is running a transactional email platform of this kind, including sending
   on behalf of my own business customers, permitted under the VPS acceptable
   use policy?
2. Can outbound port 25 be unblocked on the VPS-4 for this use case? If so,
   what is the process and what do you need from me?
3. Are additional IPv4 addresses available for a VPS in Vint Hill, and what
   is the maximum number I can attach to a single VPS?
4. Can I set reverse DNS (PTR) on each additional IPv4 myself from the
   control panel?
5. Are there any conditions, volume thresholds or account requirements I
   should meet before ordering, so that I set this up correctly the first
   time?
6. If the anti-spam system ever blocks the SMTP port, what is the
   notification and resolution process?

I would rather configure this correctly from the start than discover a
restriction after purchase. If any part of this is not supported on VPS, I am
open to a dedicated server instead — please tell me which product fits.

Thank you,

{{YOUR NAME}}
{{COMPANY, IF ANY}}
{{EMAIL}}

---

## Reading the reply

| Answer | What it means |
|---|---|
| Yes to 1–4 | Proceed with the plan as documented in `infrastructure.md`. |
| No to 3 or 4 | VPS is unusable for Box B. Move Box B to an Advance dedicated server with a `/29`; Box A stays a VPS. |
| No to 1 | Multi-tenant sending is not permitted. OVH is out for Box B — go to Hetzner, Interserver, or Hivelocity and ask the same questions. |
| "Use port 587 instead" | This is a stock answer and does not address the question. Port 587 is for submission *to* a relay; delivering to recipient MX requires outbound 25. Reply and clarify. |
| Vague or non-committal on 2 | Order Box A only. Let a month of billing history accumulate, then ask again with the service in place. |

Record the ticket reference in this file once you have it.

**Ticket reference:** `{{FILL IN}}`
**Date sent:** `{{FILL IN}}`
**Outcome:** `{{FILL IN}}`
