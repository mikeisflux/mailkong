import { prisma } from '../db.js'
import { redis } from '../redis.js'
import { config } from '../config.js'
import { paymentRequired } from '../lib/errors.js'
import type { Tenant } from '@prisma/client'

/**
 * Quota enforcement.
 *
 * Daily counters live in Redis because they are hit on every send and must
 * be atomic under concurrency. The durable record is the UsageDay rollup,
 * written by the usage job from the message table -- Redis is a fast path,
 * never the source of truth.
 */

const dayKey = (tenantId: string, day = today()) => `usage:day:${tenantId}:${day}`
const cycleKey = (tenantId: string) => `usage:cycle:${tenantId}`

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface PlanLimits {
  monthlySends: number
  domains: number
  webhooks: number
  routes: number
  retentionDays: number
  dedicatedIp: boolean
}

export function planLimits(limits: unknown): PlanLimits {
  const l = (limits ?? {}) as Partial<PlanLimits>
  return {
    monthlySends: l.monthlySends ?? 0,
    domains: l.domains ?? 0,
    webhooks: l.webhooks ?? 0,
    routes: l.routes ?? 0,
    retentionDays: l.retentionDays ?? 7,
    dedicatedIp: l.dedicatedIp ?? false,
  }
}

/** -1 means unlimited, used by the internal plan. */
const unlimited = (n: number) => n < 0

export interface QuotaSnapshot {
  dailyUsed: number
  dailyCap: number
  cycleUsed: number
  cycleCap: number
  cycleEnd: Date | null
}

export async function getQuota(tenant: Tenant): Promise<QuotaSnapshot> {
  const [dailyRaw, subscription] = await Promise.all([
    redis.get(dayKey(tenant.id)),
    prisma.subscription.findUnique({
      where: { tenantId: tenant.id },
      include: { },
    }),
  ])
  const plan = tenant.planId
    ? await prisma.plan.findUnique({ where: { id: tenant.planId } })
    : null
  const limits = planLimits(plan?.limits)

  return {
    dailyUsed: Number(dailyRaw ?? 0),
    dailyCap: tenant.dailyCap,
    cycleUsed: subscription?.sendsUsed ?? 0,
    cycleCap: limits.monthlySends,
    cycleEnd: subscription?.periodEnd ?? null,
  }
}

/**
 * Reserves one send against both the daily and monthly caps, atomically.
 *
 * Reserving BEFORE handing to Postal means a burst cannot overshoot the cap
 * by the number of in-flight requests. `releaseSend` puts the reservation
 * back when Postal rejects the message, so a failed send does not consume
 * quota the customer paid for.
 */
export async function reserveSend(tenant: Tenant, count = 1): Promise<void> {
  const plan = tenant.planId ? await prisma.plan.findUnique({ where: { id: tenant.planId } }) : null
  const limits = planLimits(plan?.limits)

  // -- daily cap (spec 14: new tenants start low and ramp) ---------------
  if (!unlimited(tenant.dailyCap)) {
    const key = dayKey(tenant.id)
    const used = await redis.incrby(key, count)
    if (used === count) await redis.expire(key, 60 * 60 * 36)
    if (used > tenant.dailyCap) {
      await redis.decrby(key, count)
      throw paymentRequired(
        'daily_cap_reached',
        `Daily sending cap of ${tenant.dailyCap} reached. It resets at midnight UTC.`,
        { cap: tenant.dailyCap, used: used - count },
      )
    }
  }

  // -- monthly plan cap ---------------------------------------------------
  if (!unlimited(limits.monthlySends) && limits.monthlySends > 0) {
    const subscription = await prisma.subscription.findUnique({ where: { tenantId: tenant.id } })
    if (subscription) {
      const used = subscription.sendsUsed + count
      if (used > limits.monthlySends && (plan?.hardStop ?? true)) {
        if (!unlimited(tenant.dailyCap)) await redis.decrby(dayKey(tenant.id), count)
        throw paymentRequired(
          'plan_cap_reached',
          `Monthly plan limit of ${limits.monthlySends.toLocaleString()} messages reached. Upgrade to continue sending.`,
          { cap: limits.monthlySends, used: subscription.sendsUsed },
        )
      }
      await prisma.subscription.update({
        where: { tenantId: tenant.id },
        data: { sendsUsed: { increment: count } },
      })
    }
  }

  await redis.incrby(cycleKey(tenant.id), count)
}

/** Compensating action when Postal refuses a message we already reserved. */
export async function releaseSend(tenant: Tenant, count = 1): Promise<void> {
  await Promise.all([
    unlimited(tenant.dailyCap) ? Promise.resolve() : redis.decrby(dayKey(tenant.id), count),
    redis.decrby(cycleKey(tenant.id), count),
    prisma.subscription
      .updateMany({ where: { tenantId: tenant.id }, data: { sendsUsed: { decrement: count } } })
      .catch(() => undefined),
  ])
}

/**
 * Spec 14: raise a new tenant's cap automatically after a clean run, rather
 * than making every new customer wait on a human.
 */
export async function maybeRaiseDailyCap(tenantId: string): Promise<number | null> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { plan: true } })
  if (!tenant || tenant.status !== 'ACTIVE') return null

  const since = tenant.capRaisedAt ?? tenant.createdAt
  const daysClean = (Date.now() - since.getTime()) / 86_400_000
  if (daysClean < config.CLEAN_DAYS_BEFORE_RAISE) return null

  const window = await prisma.usageDay.aggregate({
    where: { tenantId, day: { gte: new Date(Date.now() - config.CLEAN_DAYS_BEFORE_RAISE * 86_400_000) } },
    _sum: { sent: true, hardBounced: true, complained: true },
  })
  const sent = window._sum.sent ?? 0
  if (sent < 50) return null // not enough signal to judge

  const bounceRate = (window._sum.hardBounced ?? 0) / sent
  const complaintRate = (window._sum.complained ?? 0) / sent
  if (bounceRate > config.BOUNCE_RATE_PAUSE_THRESHOLD) return null
  if (complaintRate > config.COMPLAINT_RATE_PAUSE_THRESHOLD) return null

  const limits = planLimits(tenant.plan?.limits)
  const ceiling = unlimited(limits.monthlySends) ? 1_000_000 : Math.ceil(limits.monthlySends / 25)
  const next = Math.min(tenant.dailyCap * 4, Math.max(ceiling, tenant.dailyCap))
  if (next <= tenant.dailyCap) return null

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { dailyCap: next, capRaisedAt: new Date() },
  })
  return next
}
