import { prisma } from '../db.js'
import { redis } from '../redis.js'
import type { SuppressionReason } from '@prisma/client'

/**
 * Suppression checks sit on the send path, so the answer is cached in Redis.
 * The cache is invalidated on write rather than expiring on a timer: adding
 * a suppression must take effect on the very next send, not 60 seconds later.
 */
const cacheKey = (tenantId: string, email: string) => `supp:${tenantId}:${email.toLowerCase()}`

export async function isSuppressed(tenantId: string, email: string): Promise<boolean> {
  const key = cacheKey(tenantId, email)
  const cached = await redis.get(key)
  if (cached !== null) return cached === '1'

  const normalized = email.toLowerCase()
  const hit = await prisma.suppression.findFirst({
    where: {
      email: normalized,
      // A null tenantId row is a global suppression and applies to everyone.
      OR: [{ tenantId }, { tenantId: null }],
    },
    select: { id: true },
  })

  await redis.set(key, hit ? '1' : '0', 'EX', 300)
  return hit !== null
}

export async function suppress(input: {
  tenantId: string | null
  email: string
  reason: SuppressionReason
  detail?: string
}): Promise<void> {
  const email = input.email.toLowerCase()
  await prisma.suppression.upsert({
    where: { tenantId_email: { tenantId: input.tenantId as string, email } },
    create: {
      tenantId: input.tenantId,
      email,
      reason: input.reason,
      detail: input.detail ?? null,
    },
    update: { reason: input.reason, detail: input.detail ?? null },
  })
  await invalidate(input.tenantId, email)
}

export async function unsuppress(tenantId: string | null, email: string): Promise<number> {
  const normalized = email.toLowerCase()
  const { count } = await prisma.suppression.deleteMany({
    where: { tenantId, email: normalized },
  })
  await invalidate(tenantId, normalized)
  return count
}

async function invalidate(tenantId: string | null, email: string): Promise<void> {
  if (tenantId) {
    await redis.del(cacheKey(tenantId, email))
    return
  }
  // Global change: clear every tenant's cached answer for this address.
  const keys = await redis.keys(`supp:*:${email}`)
  if (keys.length) await redis.del(...keys)
}
