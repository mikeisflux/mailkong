import { prisma } from '../db.js'
import { config } from '../config.js'
import { postalAdmin } from '../postal/index.js'
import { logger } from '../lib/logger.js'
import { audit } from './audit.js'
import { conflict } from '../lib/errors.js'
import { getStripe } from '../billing/stripe.js'
import { encrypt } from '../lib/crypto.js'

/**
 * Signup, spec 11.
 *
 * Order matters. Stripe and Postal are both external and neither
 * participates in our transaction, so the tenant row is written last, after
 * both remote objects exist. A crash between steps leaves an orphaned Postal
 * org rather than a tenant that points at nothing -- the reconcile job in
 * jobs/reconcile.ts sweeps those up.
 */
export async function provisionTenant(input: {
  name: string
  ownerUserId: string
  ownerEmail: string
  planKey?: string
}): Promise<{ tenantId: string }> {
  const slug = slugify(input.name)
  const existing = await prisma.tenant.findUnique({ where: { slug } })
  if (existing) throw conflict('org_exists', `An organization named "${input.name}" already exists`)

  const plan = await prisma.plan.findUnique({ where: { key: input.planKey ?? 'starter' } })

  // 1. Stripe customer
  let stripeCustomerId: string | null = null
  const stripe = getStripe()
  if (stripe) {
    const customer = await stripe.customers.create({
      email: input.ownerEmail,
      name: input.name,
      metadata: { platform: 'mailkong', slug },
    })
    stripeCustomerId = customer.id
  }

  // 2. Postal organization
  const org = await postalAdmin.createOrganization({ name: input.name, permalink: slug })

  // 3. Postal server "Production" on the shared transactional pool
  const server = await postalAdmin.createServer({
    organizationPermalink: org.permalink,
    name: 'Production',
    permalink: 'production',
    mode: 'Live',
    ipPoolName: config.POSTAL_DEFAULT_POOL,
  })

  // 4. A server-scoped Postal API credential. This is what our send path
  //    authenticates with; it is never shown to the customer.
  const postalKey = await postalAdmin.createCredential(`${org.permalink}/${server.permalink}`, {
    type: 'API',
    name: 'mailkong-control-plane',
  })

  // 5. Our own records
  const tenant = await prisma.$transaction(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        name: input.name,
        slug,
        postalOrgId: org.permalink,
        stripeCustomerId,
        planId: plan?.id ?? null,
        // Spec 14: cannot send until a domain verifies.
        status: 'PAUSED_PENDING_DOMAIN',
        statusReason: 'Verify a sending domain to activate your account',
        dailyCap: config.NEW_TENANT_DAILY_CAP,
      },
    })

    await tx.membership.create({
      data: { userId: input.ownerUserId, tenantId: t.id, role: 'OWNER' },
    })

    await tx.server.create({
      data: {
        tenantId: t.id,
        postalServerId: String(server.id),
        postalPermalink: `${org.permalink}/${server.permalink}`,
        postalApiKeyEnc: encrypt(postalKey.key),
        name: 'Production',
        retentionDays: (plan?.limits as { retentionDays?: number } | null)?.retentionDays ?? 7,
      },
    })

    await tx.notificationPref.create({
      data: { tenantId: t.id, emails: [input.ownerEmail] },
    })

    if (plan) {
      const now = new Date()
      const end = new Date(now)
      end.setMonth(end.getMonth() + 1)
      await tx.subscription.create({
        data: {
          tenantId: t.id,
          planId: plan.id,
          periodStart: now,
          periodEnd: end,
          status: plan.monthlyPrice === 0 ? 'active' : 'trialing',
        },
      })
    }

    return t
  })

  await audit({
    action: 'tenant.provisioned',
    actorType: 'system',
    tenantId: tenant.id,
    payload: { postalOrgId: org.permalink, stripeCustomerId },
  })

  logger.info({ tenantId: tenant.id, slug }, 'tenant provisioned')
  return { tenantId: tenant.id }
}

/**
 * Pause, spec 11. The customer keeps dashboard access and can still see why
 * they are stopped; only sending is disabled.
 */
export async function pauseTenant(
  tenantId: string,
  reason: string,
  actor: { adminId?: string; actorType?: 'admin' | 'system' } = {},
): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { servers: true },
  })

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { status: 'PAUSED', statusReason: reason },
  })

  for (const server of tenant.servers) {
    if (!server.postalPermalink) continue
    await postalAdmin
      .holdAllCredentials(server.postalPermalink, true)
      .catch((err) => logger.error({ err, server: server.id }, 'failed to hold Postal credentials'))
  }

  await audit({
    action: 'tenant.paused',
    actorType: actor.actorType ?? 'admin',
    adminId: actor.adminId ?? null,
    tenantId,
    payload: { reason },
  })
}

export async function resumeTenant(tenantId: string, adminId?: string): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { servers: true, domains: true },
  })

  // A tenant with no verified domain goes back to pending, not active.
  const hasVerified = tenant.domains.some((d) => d.verifiedAt !== null)
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      status: hasVerified ? 'ACTIVE' : 'PAUSED_PENDING_DOMAIN',
      statusReason: hasVerified ? null : 'Verify a sending domain to activate your account',
    },
  })

  for (const server of tenant.servers) {
    if (!server.postalPermalink) continue
    await postalAdmin
      .holdAllCredentials(server.postalPermalink, false)
      .catch((err) => logger.error({ err, server: server.id }, 'failed to release Postal credentials'))
  }

  await audit({ action: 'tenant.resumed', adminId: adminId ?? null, tenantId })
}

/** Disable is harder than pause: credentials are revoked, not just held. */
export async function disableTenant(tenantId: string, reason: string, adminId?: string): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { servers: true },
  })

  await prisma.$transaction([
    prisma.tenant.update({
      where: { id: tenantId },
      data: { status: 'DISABLED', statusReason: reason },
    }),
    prisma.credential.updateMany({
      where: { tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.session.deleteMany({ where: { user: { memberships: { some: { tenantId } } } } }),
  ])

  for (const server of tenant.servers) {
    if (!server.postalPermalink) continue
    await postalAdmin
      .suspendServer(server.postalPermalink, reason)
      .catch((err) => logger.error({ err }, 'failed to suspend Postal server'))
  }

  await audit({ action: 'tenant.disabled', adminId: adminId ?? null, tenantId, payload: { reason } })
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
