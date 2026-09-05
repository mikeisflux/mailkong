import { prisma } from '../db.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { decrypt } from '../lib/crypto.js'
import { PostalServerClient } from '../postal/index.js'

/**
 * Sends the platform's own email -- verification, invites, resets, alerts.
 *
 * It goes out through the `internal` tenant's Postal server, which is the
 * point of spec 14's "your own sites are tenant zero": our own mail travels
 * the same path our customers' does, so an outage here is an outage we feel
 * before they report it.
 *
 * When the internal tenant does not exist yet -- development, or before
 * Phase 0 finishes -- this logs the message instead of throwing. Signup must
 * not fail because the platform cannot yet email itself.
 */

export interface PlatformMail {
  to: string
  subject: string
  html: string
  text: string
  tag?: string
}

let cached: { serverId: string; apiKey: string; from: string } | null = null

async function internalSender() {
  if (cached) return cached

  const tenant = await prisma.tenant.findFirst({
    where: { plan: { key: 'internal' } },
    include: { servers: true, domains: { where: { verifiedAt: { not: null } } } },
  })

  const server = tenant?.servers[0]
  const domain = tenant?.domains[0]
  if (!tenant || !server?.postalApiKeyEnc || !domain) return null

  cached = {
    serverId: server.id,
    apiKey: decrypt(server.postalApiKeyEnc),
    from: `Mailkong <no-reply@${domain.name}>`,
  }
  return cached
}

/** Clears the memoised sender. Call after provisioning the internal tenant. */
export function resetMailer(): void {
  cached = null
}

export async function sendPlatformMail(mail: PlatformMail): Promise<boolean> {
  const sender = await internalSender()

  if (!sender) {
    logger.warn(
      { to: mail.to, subject: mail.subject },
      'platform email not sent: no verified internal tenant yet. See docs/runbook-phase0.md step 10.',
    )
    if (!config.isProd) {
      // In development the link is the whole point of the email, so put it
      // where the developer will actually see it.
      logger.info({ to: mail.to, subject: mail.subject, text: mail.text }, 'platform email (dev)')
    }
    return false
  }

  try {
    const client = new PostalServerClient(sender.apiKey)
    await client.send({
      from: sender.from,
      to: [mail.to],
      subject: mail.subject,
      html_body: mail.html,
      plain_body: mail.text,
      tag: mail.tag ?? 'platform',
    })
    return true
  } catch (err) {
    // A failed notification must never fail the action that triggered it.
    logger.error({ err, to: mail.to, subject: mail.subject }, 'platform email failed')
    return false
  }
}

/**
 * Sends to whoever a tenant has nominated for operational alerts, honouring
 * the per-category preference in spec 8.2. Falls back to the owner when no
 * preference row exists.
 */
export async function notifyTenant(
  tenantId: string,
  category: 'bounceSpike' | 'capWarning' | 'webhookDown' | 'invoiceFailed',
  mail: Omit<PlatformMail, 'to'>,
): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: {
      notificationPrefs: true,
      memberships: { where: { role: 'OWNER' }, include: { user: true } },
    },
  })
  if (!tenant) return

  const prefs = tenant.notificationPrefs
  if (prefs && prefs[category] === false) return

  const recipients = prefs?.emails.length
    ? prefs.emails
    : tenant.memberships.map((m) => m.user.email)

  for (const to of new Set(recipients)) {
    await sendPlatformMail({ ...mail, to, tag: `platform-${category}` })
  }
}
