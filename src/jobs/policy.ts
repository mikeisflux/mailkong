import { prisma } from '../db.js'
import { maybeRaiseDailyCap } from '../services/usage.js'
import { checkBounceSpike } from '../services/events.js'
import { logger } from '../lib/logger.js'
import { config } from '../config.js'
import { notifyTenant } from '../mail/mailer.js'
import { templates } from '../mail/templates.js'

/**
 * Periodic enforcement of the product rules in spec 14, for the cases an
 * event alone would not catch: a tenant that stopped sending mid-spike, or
 * one whose clean window has quietly elapsed.
 */
export async function sweepPolicy(): Promise<{ raised: number; checked: number }> {
  const tenants = await prisma.tenant.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  })

  let raised = 0
  for (const tenant of tenants) {
    try {
      const next = await maybeRaiseDailyCap(tenant.id)
      if (next) {
        raised++
        logger.info({ tenantId: tenant.id, dailyCap: next }, 'daily cap raised after clean window')
      }
      await checkBounceSpike(tenant.id)
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, 'policy sweep failed for tenant')
    }
  }

  return { raised, checked: tenants.length }
}

/**
 * Spec 8.2 alerts: a webhook endpoint that has been failing for a while.
 * Notified once per streak -- the audit row is the "already told them" marker,
 * and a success resets consecutiveFailures which starts a fresh streak.
 */
export async function warnFailingWebhooks(): Promise<number> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { enabled: true, consecutiveFailures: { gte: 10 } },
    include: { tenant: true },
  })

  let warned = 0
  for (const endpoint of endpoints) {
    const already = await prisma.auditEvent.findFirst({
      where: {
        tenantId: endpoint.tenantId,
        action: 'tenant.webhook_failing',
        createdAt: { gte: endpoint.lastSuccessAt ?? new Date(0) },
        payload: { path: ['endpointId'], equals: endpoint.id },
      },
    })
    if (already) continue

    await prisma.auditEvent.create({
      data: {
        action: 'tenant.webhook_failing',
        actorType: 'system',
        tenantId: endpoint.tenantId,
        payload: { endpointId: endpoint.id, failures: endpoint.consecutiveFailures },
      },
    })
    await notifyTenant(endpoint.tenantId, 'webhookDown', {
      ...templates.webhookFailing({
        organization: endpoint.tenant.name,
        url: endpoint.url,
        failures: endpoint.consecutiveFailures,
        dashboardUrl: `${config.APP_URL}/t/${endpoint.tenantId}/webhooks`,
      }),
    })
    warned++
  }
  return warned
}

/**
 * Spec 8.2 alerts: warn before the wall, not at it. Fires once per cycle at
 * 80% by recording the notification in the audit log and checking for it.
 */
export async function warnApproachingCap(): Promise<number> {
  const subscriptions = await prisma.subscription.findMany({
    include: { tenant: { include: { plan: true, notificationPrefs: true } } },
  })

  let warned = 0
  for (const sub of subscriptions) {
    const limit = (sub.tenant.plan?.limits as { monthlySends?: number } | null)?.monthlySends ?? 0
    if (limit <= 0) continue
    if (sub.sendsUsed / limit < 0.8) continue
    if (!sub.tenant.notificationPrefs?.capWarning) continue

    const already = await prisma.auditEvent.findFirst({
      where: {
        tenantId: sub.tenantId,
        action: 'tenant.cap_warning',
        createdAt: { gte: sub.periodStart },
      },
    })
    if (already) continue

    await prisma.auditEvent.create({
      data: {
        action: 'tenant.cap_warning',
        actorType: 'system',
        tenantId: sub.tenantId,
        payload: { used: sub.sendsUsed, limit },
      },
    })
    await notifyTenant(sub.tenantId, 'capWarning', {
      ...templates.capWarning({
        organization: sub.tenant.name,
        used: sub.sendsUsed,
        limit,
        url: `${config.APP_URL}/t/${sub.tenantId}/usage`,
      }),
    })
    warned++
  }
  return warned
}
