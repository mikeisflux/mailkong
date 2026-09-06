import { prisma } from '../db.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { postalAdmin } from '../postal/index.js'
import { buildHealthAlerts } from '../admin/routes.js'
import { checkAllCertificates, sweepBlocklists } from '../services/checks.js'
import { sendPlatformMail } from '../mail/mailer.js'

/**
 * Phase 4: on-call for queue depth.
 *
 * Runs the same thresholds the admin health screen displays, imported rather
 * than duplicated, so the pager and the console can never disagree about
 * whether something is wrong.
 *
 * Two properties matter more than the checks themselves:
 *
 *   It does not repeat. An alert fires once per condition until that
 *   condition clears, because a pager that cries every five minutes gets
 *   muted, and a muted pager is worse than none.
 *
 *   It says what to do. Every alert carries the first thing to check.
 */

const REMEDY: Record<string, string> = {
  'Postal is unreachable':
    'SSH to Box B. `systemctl status postal`, then `postal status`. Check the firewall between Box A and Box B.',
  'Postal reports no live workers':
    'On Box B: `postal restart`. Workers dying repeatedly usually means MariaDB or RabbitMQ is unhappy.',
  'Postal queue depth':
    'Mail is arriving faster than it leaves. Check for one tenant sending a burst, and whether a receiving domain is deferring us.',
  'message(s) have been queued for over an hour':
    'The control plane accepted mail Postal never took. Check the agent, the server API credential, and Postal logs.',
  'of webhook deliveries failed':
    'Usually one customer endpoint down and retrying. Check the webhook delivery log before assuming it is us.',
  'control-plane database is':
    'Check that the maintenance job is running: `systemctl status mailkong-worker`. Retention pruning lives there.',
  'Sending IP listed':
    'Request delisting at the blocklist directly, and find what triggered it in Activity before it happens again.',
  'certificate for':
    'On the affected box: `certbot renew --force-renewal` then reload nginx. A renewed certificate nginx never reloaded still serves the old one.',
}

function remedyFor(message: string): string {
  for (const [needle, advice] of Object.entries(REMEDY)) {
    if (message.includes(needle)) return advice
  }
  return 'Check the admin console health screen.'
}

/** Alert identity, so the same condition does not page twice. */
function fingerprint(message: string): string {
  return message.replace(/\d+/g, '#').slice(0, 120)
}

export async function checkPlatformHealth(): Promise<{ firing: number; cleared: number }> {
  const hourAgo = new Date(Date.now() - 3_600_000)

  // The blocklist sweep runs first so the alert below sees fresh results.
  // Certificates are cheap; blocklists are a handful of DNS lookups per IP.
  await sweepBlocklists().catch((err) => logger.error({ err }, 'blocklist sweep failed'))

  const [queue, reachable, failures, total, stuck, size, certificates, addresses] = await Promise.all([
    postalAdmin.queueStats().catch(() => null),
    postalAdmin.reachable(),
    prisma.webhookDelivery.count({ where: { createdAt: { gte: hourAgo }, succeededAt: null } }),
    prisma.webhookDelivery.count({ where: { createdAt: { gte: hourAgo } } }),
    prisma.message.count({ where: { status: 'QUEUED', createdAt: { lt: hourAgo } } }),
    prisma.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database()) AS bytes`,
    checkAllCertificates().catch(() => []),
    prisma.ipAddress.findMany({ select: { address: true, blacklistStatus: true } }),
  ])

  const blocklisted = addresses.flatMap((a) => {
    const results = (a.blacklistStatus ?? []) as Array<{ name: string; listed: boolean }>
    return results.filter((r) => r.listed).map((r) => `${a.address} on ${r.name}`)
  })

  const alerts = buildHealthAlerts({
    postalUp: reachable,
    postalQueued: queue?.queued ?? 0,
    workers: queue?.workers ?? 0,
    stuck,
    webhookFailureRate: total > 0 ? failures / total : 0,
    databaseBytes: Number(size[0]?.bytes ?? 0),
    certificateDays: certificates
      .filter((c) => c.daysRemaining !== null)
      .map((c) => ({ host: c.host, days: c.daysRemaining! })),
    blocklistedIps: blocklisted,
  })

  const active = new Set(alerts.map((a) => fingerprint(a.message)))

  // Anything currently open that is no longer firing has recovered.
  const open = await prisma.auditEvent.findMany({
    where: { action: 'platform.alert_fired', createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const stillOpen = new Map<string, string>()
  for (const event of open) {
    const fp = (event.payload as { fingerprint?: string } | null)?.fingerprint
    if (!fp) continue
    if (!stillOpen.has(fp)) stillOpen.set(fp, event.id)
  }

  const resolved = await prisma.auditEvent.findMany({
    where: { action: 'platform.alert_cleared', createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  for (const event of resolved) {
    const fp = (event.payload as { fingerprint?: string } | null)?.fingerprint
    // A clear that is newer than the fire closes it.
    if (fp && stillOpen.has(fp)) {
      const firedAt = open.find((o) => (o.payload as { fingerprint?: string } | null)?.fingerprint === fp)
      if (firedAt && event.createdAt > firedAt.createdAt) stillOpen.delete(fp)
    }
  }

  let firing = 0
  for (const alert of alerts) {
    const fp = fingerprint(alert.message)
    if (stillOpen.has(fp)) continue

    await prisma.auditEvent.create({
      data: {
        action: 'platform.alert_fired',
        actorType: 'system',
        payload: { fingerprint: fp, level: alert.level, message: alert.message },
      },
    })

    logger.error({ alert: alert.message, level: alert.level }, 'platform alert')
    await page(alert.level, alert.message)
    firing++
  }

  let cleared = 0
  for (const [fp] of stillOpen) {
    if (active.has(fp)) continue
    await prisma.auditEvent.create({
      data: {
        action: 'platform.alert_cleared',
        actorType: 'system',
        payload: { fingerprint: fp },
      },
    })
    logger.info({ fingerprint: fp }, 'platform alert cleared')
    cleared++
  }

  return { firing, cleared }
}

/**
 * Notifies whoever is on call.
 *
 * Email to the superadmins is the floor, not the goal: platform email goes
 * through our own Postal, so an outage that takes Postal down also takes this
 * path down. Wire ALERT_WEBHOOK_URL to something off this infrastructure --
 * PagerDuty, Slack, a phone -- for anything you actually want to be woken by.
 */
async function page(level: string, message: string): Promise<void> {
  const remedy = remedyFor(message)

  if (config.ALERT_WEBHOOK_URL) {
    try {
      await fetch(config.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level,
          service: 'mailkong',
          message,
          remedy,
          console: `${config.ADMIN_URL}/system`,
        }),
        signal: AbortSignal.timeout(8000),
      })
    } catch (err) {
      logger.error({ err }, 'alert webhook failed')
    }
  }

  const operators = await prisma.adminUser.findMany({
    where: { role: 'SUPERADMIN', disabledAt: null },
    select: { email: true },
  })

  for (const { email } of operators) {
    await sendPlatformMail({
      to: email,
      subject: `[${level.toUpperCase()}] Mailkong: ${message.slice(0, 60)}`,
      tag: 'platform-alert',
      text: `${message}\n\nFirst thing to check:\n${remedy}\n\nHealth screen: ${config.ADMIN_URL}/system`,
      html: `<p><strong>${escapeHtml(message)}</strong></p>
             <p><strong>First thing to check:</strong><br>${escapeHtml(remedy)}</p>
             <p><a href="${config.ADMIN_URL}/system">Open the health screen</a></p>`,
    })
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
