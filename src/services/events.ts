import { prisma } from '../db.js'
import { logger } from '../lib/logger.js'
import { enqueueWebhook, type WebhookEvent } from './webhooks.js'
import { suppress } from './suppressions.js'
import { pauseTenant } from './provisioning.js'
import { config } from '../config.js'
import { notifyTenant } from '../mail/mailer.js'
import { templates } from '../mail/templates.js'
import type { MessageStatus } from '@prisma/client'

/**
 * Ingests Postal's outgoing webhooks and turns them into our own state:
 * message status, suppressions, tenant-facing events, and the automatic
 * pause in spec 14.
 *
 * Postal's event names are fixed by Postal; ours are the customer-facing
 * names in spec 8.2. This is the only place the two vocabularies meet.
 */
const STATUS_BY_EVENT: Record<string, MessageStatus> = {
  MessageSent: 'SENT',
  MessageDelayed: 'PENDING',
  MessageDeliveryFailed: 'FAILED',
  MessageHeld: 'HELD',
  MessageBounced: 'BOUNCED',
}

const CUSTOMER_EVENT: Record<string, WebhookEvent> = {
  MessageSent: 'message.delivered',
  MessageDeliveryFailed: 'message.failed',
  MessageBounced: 'message.bounced',
  MessageLinkClicked: 'message.clicked',
  MessageLoaded: 'message.opened',
}

export interface PostalEvent {
  event: string
  timestamp?: number
  payload: {
    message?: { id?: number; token?: string; to?: string; direction?: string; tag?: string | null }
    status?: string
    details?: string
    output?: string
    bounce?: { id?: number; to?: string }
    url?: string
    ip_address?: string
    user_agent?: string
  }
}

export async function ingestPostalEvent(event: PostalEvent): Promise<void> {
  const postalId = event.payload.message?.id
  if (!postalId) {
    logger.debug({ event: event.event }, 'postal event without message id, ignored')
    return
  }

  const message = await prisma.message.findFirst({
    where: { postalMessageId: String(postalId) },
  })
  if (!message) {
    // Mail sent directly through Postal, or an event for a message whose
    // index row was pruned. Not an error.
    logger.debug({ postalId, event: event.event }, 'no indexed message for postal event')
    return
  }

  const status = STATUS_BY_EVENT[event.event]
  const now = new Date()

  await prisma.message.update({
    where: { id: message.id },
    data: {
      ...(status ? { status } : {}),
      ...(event.event === 'MessageSent' ? { deliveredAt: now } : {}),
      ...(event.event === 'MessageDeliveryFailed' ? { failedAt: now } : {}),
      ...(event.event === 'MessageLoaded' ? { openedAt: message.openedAt ?? now } : {}),
      ...(event.event === 'MessageLinkClicked' ? { clickedAt: message.clickedAt ?? now } : {}),
      ...(event.payload.details ? { bounceReason: event.payload.details.slice(0, 1000) } : {}),
    },
  })

  // Spec 14: hard bounces and complaints auto-suppress.
  if (event.event === 'MessageBounced' || isHardBounce(event)) {
    await suppress({
      tenantId: message.tenantId,
      email: message.to,
      reason: 'HARD_BOUNCE',
      detail: event.payload.details?.slice(0, 500),
    })
  }

  const customerEvent = CUSTOMER_EVENT[event.event]
  if (customerEvent) {
    await enqueueWebhook(message.tenantId, customerEvent, {
      id: message.id,
      to: message.to,
      from: message.from,
      subject: message.subject,
      tag: message.tag,
      status: (status ?? message.status).toLowerCase(),
      reason: event.payload.details ?? null,
      url: event.payload.url ?? null,
    })
  }

  if (status === 'BOUNCED' || status === 'FAILED') {
    await checkBounceSpike(message.tenantId)
  }
}

/**
 * Postal reports a permanent failure as MessageDeliveryFailed with a 5xx in
 * the output; a soft failure retries and is not a suppression event.
 */
function isHardBounce(event: PostalEvent): boolean {
  if (event.event !== 'MessageDeliveryFailed') return false
  const output = event.payload.output ?? ''
  return /\b5\d\d\b/.test(output)
}

/**
 * Spec 14: a bounce or complaint spike auto-pauses the tenant and opens an
 * admin alert, so one customer cannot sink the shared pool overnight.
 *
 * Measured over the trailing 24h with a floor on volume, because 2 bounces
 * out of 3 sends is noise, not a spike.
 */
export async function checkBounceSpike(tenantId: string): Promise<void> {
  const since = new Date(Date.now() - 86_400_000)
  const [total, bounced, complained] = await Promise.all([
    prisma.message.count({ where: { tenantId, createdAt: { gte: since } } }),
    prisma.message.count({
      where: { tenantId, createdAt: { gte: since }, status: { in: ['BOUNCED', 'FAILED'] } },
    }),
    prisma.suppression.count({
      where: { tenantId, reason: 'COMPLAINT', createdAt: { gte: since } },
    }),
  ])

  if (total < 100) return

  const bounceRate = bounced / total
  const complaintRate = complained / total
  const overBounce = bounceRate > config.BOUNCE_RATE_PAUSE_THRESHOLD
  const overComplaint = complaintRate > config.COMPLAINT_RATE_PAUSE_THRESHOLD
  if (!overBounce && !overComplaint) return

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant || tenant.status !== 'ACTIVE') return

  const reason = overBounce
    ? `Automatic pause: ${(bounceRate * 100).toFixed(1)}% bounce rate over the last 24 hours (threshold ${(config.BOUNCE_RATE_PAUSE_THRESHOLD * 100).toFixed(1)}%)`
    : `Automatic pause: ${(complaintRate * 100).toFixed(2)}% complaint rate over the last 24 hours`

  await pauseTenant(tenantId, reason, { actorType: 'system' })

  await prisma.abuseTicket.create({
    data: {
      tenantId,
      source: 'auto_bounce_spike',
      subject: overBounce ? 'Bounce rate spike' : 'Complaint rate spike',
      raw: JSON.stringify({ total, bounced, complained, bounceRate, complaintRate }, null, 2),
      status: 'NEW',
    },
  })

  const paused = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (paused) {
    await notifyTenant(tenantId, 'bounceSpike', {
      ...templates.bounceSpike({
        organization: paused.name,
        rate: overBounce ? bounceRate : complaintRate,
        reason,
        url: `${config.APP_URL}/t/${tenantId}`,
      }),
    })
  }

  logger.warn({ tenantId, bounceRate, complaintRate }, 'tenant auto-paused on spike')
}

/** Inbound mail arriving on a route, delivered to the customer's webhook. */
export async function ingestInboundMessage(input: {
  routeId: string
  from: string
  to: string
  subject: string
  plainBody?: string
  htmlBody?: string
  headers?: Record<string, string>
  attachments?: unknown[]
  spamScore?: number
}): Promise<void> {
  const route = await prisma.inboundRoute.findUnique({ where: { id: input.routeId } })
  if (!route || !route.enabled) return

  if (route.spamThreshold !== null && (input.spamScore ?? 0) > route.spamThreshold) {
    logger.info({ routeId: route.id, score: input.spamScore }, 'inbound message dropped as spam')
    return
  }

  await enqueueWebhook(route.tenantId, 'inbound.message', {
    route: { id: route.id, address: route.address, domain: route.domain },
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.plainBody ?? null,
    html: input.htmlBody ?? null,
    headers: input.headers ?? {},
    attachments: input.attachments ?? [],
    spam_score: input.spamScore ?? null,
  })
}
