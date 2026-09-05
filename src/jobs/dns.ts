import { prisma } from '../db.js'
import { checkDomain } from '../services/domains.js'
import { logger } from '../lib/logger.js'

/**
 * Re-checks domains on a rolling basis.
 *
 * Priority is deliberately uneven: a domain the customer is waiting on gets
 * checked every couple of minutes so the onboarding screen feels live, while
 * a long-verified domain is checked hourly just to catch DNS that broke.
 */
export async function sweepDomains(): Promise<{ checked: number }> {
  const now = Date.now()
  const domains = await prisma.domain.findMany({
    where: {
      OR: [
        // Never checked, or unverified and checked more than 2 minutes ago.
        { lastCheckedAt: null },
        { verifiedAt: null, lastCheckedAt: { lt: new Date(now - 120_000) } },
        // Verified: hourly re-check to catch broken DNS (spec 8.2 alerts).
        { verifiedAt: { not: null }, lastCheckedAt: { lt: new Date(now - 3_600_000) } },
      ],
    },
    orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: 50,
  })

  let checked = 0
  for (const domain of domains) {
    try {
      const before = domain.verifiedAt !== null
      const after = await checkDomain(domain.id)
      checked++

      if (before && after.verifiedAt === null) {
        logger.warn({ domainId: domain.id, name: domain.name }, 'domain fell out of verification')
      }
    } catch (err) {
      logger.error({ err, domainId: domain.id }, 'domain check failed')
      await prisma.domain.update({
        where: { id: domain.id },
        data: { lastCheckedAt: new Date(), lastCheckOutput: String(err).slice(0, 500) },
      })
    }
  }

  return { checked }
}
