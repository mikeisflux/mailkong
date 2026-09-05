# Phase 0 runbook — bare Ubuntu to first message

Takes both OVH VPS from delivery to the internal tenant sending real mail.
Assumes the port 25 request in `ovh-support-request.md` came back positive
and both boxes are in Vint Hill running Ubuntu 24.04.

Placeholders: `BOX_A_IP`, `BOX_B_IP`, `SEND_IP_1`, `SEND_IP_2`.

---

## 0. Before you touch either box

Check every delivered IP against blocklists **first**. Swapping a listed
address is easy on day one and hard a month later.

```bash
for ip in BOX_B_IP SEND_IP_1 SEND_IP_2; do
  rev=$(echo $ip | awk -F. '{print $4"."$3"."$2"."$1}')
  for bl in zen.spamhaus.org b.barracudacentral.org dnsbl.sorbs.net; do
    printf '%-16s %-26s ' "$ip" "$bl"
    host "$rev.$bl" >/dev/null 2>&1 && echo LISTED || echo clean
  done
done
```

Anything `LISTED` → open an OVH ticket asking for a replacement before going
further.

## 1. Harden both boxes

```bash
ssh root@BOX_A_IP   # repeat for BOX_B_IP

apt update && apt upgrade -y
apt install -y ufw fail2ban unattended-upgrades curl git
dpkg-reconfigure -plow unattended-upgrades

adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/;
        s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

**Confirm you can still log in as `deploy` in a second terminal before
closing this one.**

## 2. Firewalls

Box A — the control plane. Nothing but HTTPS is public.

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow from YOUR_IP to any port 22 proto tcp
ufw allow 80,443/tcp
ufw --force enable
```

Box B — the mail box. Port 25 both ways, 587 for submission, Postal's UI
locked to you.

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow from YOUR_IP to any port 22 proto tcp
ufw allow 25/tcp        # inbound MX and outbound delivery
ufw allow 587/tcp       # customer submission
ufw allow 80,443/tcp    # Let's Encrypt + Postal UI (allowlisted in nginx)
ufw allow from BOX_A_IP to any port 443 proto tcp
ufw --force enable
```

## 3. Additional IPs on Box B

Order them in the OVH panel, then attach them. OVH VPS additional IPs share
the primary gateway.

```bash
# /etc/netplan/50-cloud-init.yaml
network:
  version: 2
  ethernets:
    ens3:
      addresses:
        - BOX_B_IP/32
        - SEND_IP_1/32
        - SEND_IP_2/32
      routes:
        - to: default
          via: PRIMARY_GATEWAY
          on-link: true
```

```bash
netplan apply && ip -4 addr show ens3
```

## 4. DNS, then PTR — in that order

Publish `infra/dns/mailkong.net.zone` at your DNS provider.

**OVH validates the forward record before accepting a PTR**, so the A records
must resolve first:

```bash
dig +short mta1.mailkong.net   # must return SEND_IP_1
dig +short mta2.mailkong.net   # must return SEND_IP_2
```

Then in the OVH panel: **Network → Public IP Addresses → ⋯ → Modify the
reverse**, setting each sending IP to its `mta*` hostname.

Verify the loop closes — this is forward-confirmed reverse DNS, and Gmail and
Microsoft defer mail without it:

```bash
for h in mta1 mta2; do
  ip=$(dig +short $h.mailkong.net)
  echo "$h.mailkong.net -> $ip -> $(dig +short -x $ip)"
done
```

Both lines must round-trip. **Do not send any mail until they do** — the
default OVH PTR marks you as generic hosting on your very first message.

## 5. Postal on Box B

```bash
sudo -u deploy -i
git clone https://github.com/postalserver/install /opt/postal/install
sudo /opt/postal/install/bin/postal bootstrap postal.mailkong.net
```

Edit `/opt/postal/config/postal.yml`:

```yaml
web:
  host: postal.mailkong.net
dns:
  mx_records:
    - mta1.mailkong.net
  smtp_server_hostname: mta1.mailkong.net
  spf_include: spf.mailkong.net
  return_path_domain: rp.mailkong.net
  route_domain: routes.mailkong.net
  track_domain: track.mailkong.net
smtp_server:
  port: 25
```

```bash
sudo postal initialize
sudo postal make-user      # your staff account; not a customer login
sudo postal start
```

## 6. Provisioning agent on Box B

Postal cannot create organizations over HTTP, so the control plane talks to
the agent. Follow `infra/postal-agent/README.md`, then keep the token — it is
`POSTAL_API_KEY` on Box A.

```bash
curl -s -H "Authorization: Bearer $AGENT_TOKEN" localhost:5000/health
```

## 7. Control plane on Box A

```bash
sudo apt install -y postgresql redis-server nginx certbot python3-certbot-nginx
sudo -u postgres createuser --pwprompt mailkong
sudo -u postgres createdb -O mailkong mailkong

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

git clone <your-repo> /opt/mailkong && cd /opt/mailkong
npm ci
cp .env.example .env
```

Fill in `.env`. Generate the two secrets rather than inventing them:

```bash
echo "SESSION_SECRET=$(openssl rand -base64 48)"
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
```

`ENCRYPTION_KEY` encrypts Postal credentials at rest. **Rotating it without
re-encrypting makes every stored credential unreadable**, which means every
tenant stops sending.

```bash
npm run db:deploy
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='<strong>' npm run db:seed
npm run build
```

Then run `mailkong.service` and `mailkong-worker.service` from `infra/systemd/`,
and put nginx in front with `infra/nginx/`.

## 8. Certificates

```bash
sudo certbot --nginx -d app.mailkong.net -d admin.mailkong.net \
  -d api.mailkong.net -d track.mailkong.net          # Box A
sudo certbot --nginx -d postal.mailkong.net           # Box B
```

## 9. Point Postal's webhooks back at the control plane

Postal must POST delivery events to Box A. In the Postal UI, add a webhook on
the server pointing at:

```
https://api.mailkong.net/_postal/events
```

with header `X-Postal-Token` set to the value printed by:

```bash
node -e "const c=require('crypto');console.log(c.createHash('sha256').update('postal-events:'+process.env.POSTAL_API_KEY).digest('hex'))"
```

Without this, messages stay `queued` forever in the dashboard, bounces never
suppress, and the auto-pause in spec 14 never fires.

## 10. The internal tenant

Spec 14: your own sites are tenant zero, on the `internal` plan at $0, using
the same dashboard you sell.

1. Sign in to `admin.mailkong.net`, enrol TOTP.
2. Turn `signup_open` **off** if it is not already. Public signup waits for
   Phase 2.
3. Create the account at `app.mailkong.net/signup`, organization `Internal`.
4. Set its plan to `internal` from the tenant screen.
5. Add your first real sending domain and publish the records it shows.
6. Send a test message to a Gmail address **and** an Outlook address.

## 11. Verify before you call Phase 0 done

Open the test message's raw headers in Gmail and confirm all three:

```
spf=pass       header.i=@yourdomain.com
dkim=pass      header.i=@yourdomain.com
dmarc=pass     header.from=yourdomain.com
```

Then check the platform end to end:

```bash
curl -s https://api.mailkong.net/health           # ok:true, db, redis
```

- [ ] Both PTRs round-trip
- [ ] SPF, DKIM and DMARC all pass at Gmail **and** Outlook
- [ ] The message appears in Activity with status `delivered`
- [ ] An inbound route POSTs JSON to a test endpoint
- [ ] Admin can find the message by recipient without opening Postal
- [ ] `signup_open` is off

The last one matters. Spec 15: *"Do not open public signup until Phase 2
exists. You need pause + search before strangers send through your IPs."*

## Warm-up

New IPs cannot take full volume on day one. Raise the pool's warm-up cap in
the admin console roughly on this curve, holding a step if bounce rate crosses
2%:

| Day | Cap per IP |
|---|---|
| 1–2 | 50 |
| 3–4 | 200 |
| 5–7 | 1,000 |
| 8–14 | 5,000 |
| 15–21 | 20,000 |
| 22+ | clear the warming flag |
