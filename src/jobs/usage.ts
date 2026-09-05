import { prisma } from '../db.js'
import { logger } from '../lib/logger.js'

/**
 * Rolls the message index into per-day counters.
 *
 * Recomputes today and yesterday on every pass rather than incrementing,
 * because message rows change status after creation (queued -> delivered ->
 * bounced) and an incremental counter would drift permanently.
 */
export async function rollupUsage(): Promise<{ tenants: number }> {
  const days = [startOfDay(new Date()), startOfDay(new Date(Date.now() - 86_400_000))]
  const tenants = await prisma.tenant.findMany({ select: { id: true } })

  for (const tenant of tenants) {
    for (const day of days) {
      const next = new Date(day.getTime() + 86_400_000)
      const rows = await prisma.message.groupBy({
        by: ['status'],
        where: { tenantId: tenant.id, createdAt: { gte: day, lt: next } },
        _count: { _all: true },
      })
      if (rows.length === 0) continue

      const count = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0
      const complained = await prisma.suppression.count({
        where: { tenantId: tenant.id, reason: 'COMPLAINT', createdAt: { gte: day, lt: next } },
      })
      const hardBounced = await prisma.suppression.count({
        where: { tenantId: tenant.id, reason: 'HARD_BOUNCE', createdAt: { gte: day, lt: next } },
      })

      const data = {
        sent: rows.reduce((n, r) => n + r._count._all, 0),
        delivered: count('DELIVERED') + count('SENT'),
        bounced: count('BOUNCED'),
        failed: count('FAILED'),
        held: count('HELD'),
        hardBounced,
        complained,
      }

      await prisma.usageDay.upsert({
        where: { tenantId_day: { tenantId: tenant.id, day } },
        create: { tenantId: tenant.id, day, ...data },
        update: data,
      })
    }
  }

  logger.debug({ tenants: tenants.length }, 'usage rollup complete')
  return { tenants: tenants.length }
}

/**
 * Retention, per plan. Spec 6 sells 7/30/90 days and section 12 says bodies
 * stay in Postal -- this prunes only our index, which is what makes the
 * 200 GB disk projection in docs/infrastructure.md hold.
 */
export async function pruneMessages(): Promise<{ deleted: number }> {
  const servers = await prisma.server.findMany({ select: { id: true, retentionDays: true } })
  let deleted = 0
  for (const server of servers) {
    const cutoff = new Date(Date.now() - server.retentionDays * 86_400_000)
    const { count } = await prisma.message.deleteMany({
      where: { serverId: server.id, createdAt: { lt: cutoff } },
    })
    deleted += count
  }
  return { deleted }
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
