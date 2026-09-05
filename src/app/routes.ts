import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { randomToken, sha256, encrypt } from '../lib/crypto.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js'
import { readSession } from '../auth/session.js'
import { requireMember, type Capability } from '../auth/rbac.js'
import { addDomain, checkDomain, removeDomain } from '../services/domains.js'
import { createCredential, revokeCredential } from '../services/credentials.js'
import { sendMessage } from '../services/send.js'
import { suppress, unsuppress } from '../services/suppressions.js'
import { getQuota, planLimits } from '../services/usage.js'
import { WEBHOOK_EVENTS } from '../services/webhooks.js'
import { audit } from '../services/audit.js'
import { authRoutes } from './auth.js'
import { checkoutRoutes } from '../billing/checkout.js'
import { postalAdmin } from '../postal/index.js'
import type { MemberRole } from '@prisma/client'

/**
 * Backend for the customer dashboard at app.mailkong.net.
 *
 * Session-authenticated rather than API-key authenticated, and scoped to the
 * tenant the signed-in user is a member of. Every mutating handler passes
 * through `requireMember` so the role matrix in spec 8.3 is enforced in one
 * place rather than per-screen.
 */

interface Ctx {
  userId: string
  tenantId: string
  role: MemberRole
  impersonatorAdminId: string | null
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes)
  await app.register(checkoutRoutes)

  app.get('/me', async (req) => {
    const session = await readSession(req)
    if (!session) throw unauthorized('Not signed in')

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: session.userId },
      include: {
        memberships: { include: { tenant: { include: { plan: true } } } },
      },
    })

    return {
      user: { id: user.id, email: user.email, name: user.name },
      impersonated: session.impersonatorAdminId !== null,
      tenants: user.memberships.map((m) => ({
        id: m.tenant.id,
        name: m.tenant.name,
        slug: m.tenant.slug,
        role: m.role.toLowerCase(),
        status: m.tenant.status.toLowerCase(),
        status_reason: m.tenant.statusReason,
        plan: m.tenant.plan?.key ?? null,
      })),
    }
  })

  // ------------------------------------------------------------- dashboard

  app.get('/t/:tenantId/overview', async (req) => {
    const ctx = await context(req)
    const since24 = new Date(Date.now() - 86_400_000)

    const [quota, byStatus, domains, recent, alerts] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } }).then(getQuota),
      prisma.message.groupBy({
        by: ['status'],
        where: { tenantId: ctx.tenantId, createdAt: { gte: since24 } },
        _count: { _all: true },
      }),
      prisma.domain.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'asc' } }),
      prisma.message.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      buildAlerts(ctx.tenantId),
    ])

    const total = byStatus.reduce((n, r) => n + r._count._all, 0)
    const bounced = byStatus.find((r) => r.status === 'BOUNCED')?._count._all ?? 0

    return {
      quota,
      last24h: {
        total,
        bounced,
        bounce_rate: total > 0 ? bounced / total : 0,
        by_status: Object.fromEntries(byStatus.map((r) => [r.status.toLowerCase(), r._count._all])),
      },
      domains: domains.map((d) => ({
        id: d.id,
        name: d.name,
        verified: d.verifiedAt !== null,
        spf: d.spfOk,
        dkim: d.dkimOk,
        dmarc: d.dmarcOk,
      })),
      recent: recent.map((m) => ({
        id: m.id,
        to: m.to,
        subject: m.subject,
        status: m.status.toLowerCase(),
        created_at: m.createdAt.toISOString(),
      })),
      alerts,
    }
  })

  // ----------------------------------------------------------------- CRUD

  app.get('/t/:tenantId/domains', async (req) => {
    const ctx = await context(req, 'domains:read')
    return {
      data: await prisma.domain.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'asc' },
      }),
    }
  })

  app.post('/t/:tenantId/domains', async (req, reply) => {
    const ctx = await context(req, 'domains:write')
    const body = z.object({
      name: z.string().min(3),
      kind: z.enum(['SENDING', 'TRACKING', 'INBOUND']).default('SENDING'),
    }).parse(req.body)
    reply.code(201)
    return addDomain({ tenantId: ctx.tenantId, name: body.name, kind: body.kind, actorId: ctx.userId })
  })

  app.post<{ Params: { tenantId: string; id: string } }>('/t/:tenantId/domains/:id/check', async (req) => {
    const ctx = await context(req, 'domains:write')
    const domain = await prisma.domain.findFirst({ where: { id: req.params.id, tenantId: ctx.tenantId } })
    if (!domain) throw notFound('Domain')
    return checkDomain(domain.id)
  })

  app.delete<{ Params: { tenantId: string; id: string } }>('/t/:tenantId/domains/:id', async (req, reply) => {
    const ctx = await context(req, 'domains:write')
    const domain = await prisma.domain.findFirst({ where: { id: req.params.id, tenantId: ctx.tenantId } })
    if (!domain) throw notFound('Domain')
    await removeDomain(domain.id, ctx.userId)
    reply.code(204)
  })

  app.get('/t/:tenantId/credentials', async (req) => {
    const ctx = await context(req, 'credentials')
    const credentials = await prisma.credential.findMany({
      where: { tenantId: ctx.tenantId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    return {
      smtp: {
        host: config.POSTAL_SMTP_HOST,
        port: config.POSTAL_SMTP_PORT,
        security: 'STARTTLS',
      },
      data: credentials,
    }
  })

  app.post('/t/:tenantId/credentials', async (req, reply) => {
    const ctx = await context(req, 'credentials')
    const body = z.object({
      kind: z.enum(['API_KEY', 'SMTP']),
      name: z.string().min(1).max(60),
    }).parse(req.body)
    reply.code(201)
    return createCredential({ tenantId: ctx.tenantId, kind: body.kind, name: body.name, actorId: ctx.userId })
  })

  app.delete<{ Params: { tenantId: string; id: string } }>('/t/:tenantId/credentials/:id', async (req, reply) => {
    const ctx = await context(req, 'credentials')
    await revokeCredential(req.params.id, ctx.tenantId, ctx.userId)
    reply.code(204)
  })

  /** Test send goes through the same path as the API, per spec 8.2. */
  app.post('/t/:tenantId/test-send', async (req) => {
    const ctx = await context(req, 'send')
    const body = z.object({
      from: z.string().min(3),
      to: z.string().email(),
      subject: z.string().min(1),
      html: z.string().optional(),
      text: z.string().optional(),
    }).parse(req.body)

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } })
    return sendMessage(tenant, {
      from: body.from,
      to: [body.to],
      subject: body.subject,
      html: body.html,
      text: body.text ?? 'Test message from Mailkong.',
      tag: 'test-send',
    })
  })

  app.get('/t/:tenantId/activity', async (req) => {
    const ctx = await context(req, 'activity')
    const q = z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      cursor: z.string().optional(),
      status: z.string().optional(),
      search: z.string().optional(),
    }).parse(req.query)

    const rows = await prisma.message.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
        ...(q.search
          ? {
              OR: [
                { to: { contains: q.search, mode: 'insensitive' } },
                { subject: { contains: q.search, mode: 'insensitive' } },
                { tag: { contains: q.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    })

    const hasMore = rows.length > q.limit
    return { data: hasMore ? rows.slice(0, q.limit) : rows, has_more: hasMore }
  })

  app.get<{ Params: { tenantId: string; id: string } }>('/t/:tenantId/activity/:id', async (req) => {
    const ctx = await context(req, 'activity')
    const message = await prisma.message.findFirst({
      where: { id: req.params.id, tenantId: ctx.tenantId },
    })
    if (!message) throw notFound('Message')

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { endpoint: { tenantId: ctx.tenantId } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    return { message, webhook_deliveries: deliveries }
  })

  app.get('/t/:tenantId/webhooks', async (req) => {
    const ctx = await context(req, 'activity')
    return {
      events: WEBHOOK_EVENTS,
      data: await prisma.webhookEndpoint.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        include: {
          deliveries: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
      }),
    }
  })

  app.post('/t/:tenantId/webhooks', async (req, reply) => {
    const ctx = await context(req, 'credentials')
    const body = z.object({
      url: z.string().url(),
      events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
    }).parse(req.body)

    const secret = `whsec_${randomToken(24)}`
    const endpoint = await prisma.webhookEndpoint.create({
      data: { tenantId: ctx.tenantId, url: body.url, events: body.events, secretEnc: encrypt(secret) },
    })
    reply.code(201)
    return { ...endpoint, secret }
  })

  app.delete<{ Params: { tenantId: string; id: string } }>('/t/:tenantId/webhooks/:id', async (req, reply) => {
    const ctx = await context(req, 'credentials')
    await prisma.webhookEndpoint.deleteMany({ where: { id: req.params.id, tenantId: ctx.tenantId } })
    reply.code(204)
  })

  app.get('/t/:tenantId/suppressions', async (req) => {
    const ctx = await context(req, 'activity')
    return {
      data: await prisma.suppression.findMany({
        where: { OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    }
  })

  app.post('/t/:tenantId/suppressions', async (req, reply) => {
    const ctx = await context(req, 'credentials')
    const body = z.object({ email: z.string().email() }).parse(req.body)
    await suppress({ tenantId: ctx.tenantId, email: body.email, reason: 'MANUAL' })
    reply.code(201)
    return { ok: true }
  })

  app.delete<{ Params: { tenantId: string; email: string } }>(
    '/t/:tenantId/suppressions/:email',
    async (req, reply) => {
      const ctx = await context(req, 'credentials')
      await unsuppress(ctx.tenantId, decodeURIComponent(req.params.email))
      reply.code(204)
    },
  )

  // ------------------------------------------------------------- inbound

  app.get('/t/:tenantId/inbound', async (req) => {
    const ctx = await context(req, 'activity')
    return {
      data: await prisma.inboundRoute.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
      }),
    }
  })

  app.post('/t/:tenantId/inbound', async (req, reply) => {
    const ctx = await context(req, 'credentials')
    const body = z.object({
      address: z.string().min(1).max(64),
      domain: z.string().min(3),
      endpoint_url: z.string().url(),
    }).parse(req.body)

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
      include: { plan: true },
    })
    const limits = planLimits(tenant.plan?.limits)
    const count = await prisma.inboundRoute.count({ where: { tenantId: ctx.tenantId } })
    if (limits.routes >= 0 && count >= limits.routes) {
      throw conflict('route_limit', `Your plan allows ${limits.routes} inbound routes`)
    }

    const server = await prisma.server.findFirst({ where: { tenantId: ctx.tenantId } })
    let postalRouteId: string | null = null
    if (server?.postalPermalink) {
      const created = await postalAdmin.createRoute(server.postalPermalink, {
        name: body.address,
        domain: body.domain,
        endpointUrl: body.endpoint_url,
      })
      postalRouteId = String(created.id)
    }

    const route = await prisma.inboundRoute.create({
      data: {
        tenantId: ctx.tenantId,
        serverId: server?.id ?? null,
        postalRouteId,
        address: body.address,
        domain: body.domain,
        endpointUrl: body.endpoint_url,
      },
    })
    reply.code(201)
    return route
  })

  app.delete<{ Params: { tenantId: string; id: string } }>('/t/:tenantId/inbound/:id', async (req, reply) => {
    const ctx = await context(req, 'credentials')
    const route = await prisma.inboundRoute.findFirst({
      where: { id: req.params.id, tenantId: ctx.tenantId },
      include: { server: true },
    })
    if (!route) throw notFound('Route')
    if (route.server?.postalPermalink && route.postalRouteId) {
      await postalAdmin
        .deleteRoute(route.server.postalPermalink, Number(route.postalRouteId))
        .catch(() => undefined)
    }
    await prisma.inboundRoute.delete({ where: { id: route.id } })
    reply.code(204)
  })

  app.get('/t/:tenantId/usage', async (req) => {
    const ctx = await context(req, 'activity')
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
      include: { plan: true, subscription: true },
    })
    const [quota, history] = await Promise.all([
      getQuota(tenant),
      prisma.usageDay.findMany({
        where: { tenantId: ctx.tenantId, day: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        orderBy: { day: 'asc' },
      }),
    ])
    return {
      quota,
      plan: tenant.plan,
      limits: planLimits(tenant.plan?.limits),
      subscription: tenant.subscription,
      history,
    }
  })

  app.get('/t/:tenantId/team', async (req) => {
    const ctx = await context(req, 'activity')
    return {
      members: await prisma.membership.findMany({
        where: { tenantId: ctx.tenantId },
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      invites: await prisma.invite.findMany({
        where: { tenantId: ctx.tenantId, acceptedAt: null },
      }),
    }
  })

  app.post('/t/:tenantId/team/invites', async (req, reply) => {
    const ctx = await context(req, 'team')
    const body = z.object({
      email: z.string().email(),
      role: z.enum(['ADMIN', 'DEVELOPER', 'READ_ONLY']),
    }).parse(req.body)

    const token = randomToken()
    await prisma.invite.create({
      data: {
        tenantId: ctx.tenantId,
        email: body.email.toLowerCase(),
        role: body.role,
        tokenHash: sha256(token),
        invitedBy: ctx.userId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    })
    await audit({
      action: 'team.invited',
      actorType: 'user',
      actorId: ctx.userId,
      tenantId: ctx.tenantId,
      payload: { email: body.email, role: body.role },
    })
    reply.code(201)
    return { invite_url: `${config.APP_URL}/invite/${token}` }
  })
}

// --------------------------------------------------------------- helpers

const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000'

async function context(req: FastifyRequest, capability?: Capability): Promise<Ctx> {
  const session = await readSession(req)
  if (!session) throw unauthorized('Not signed in')

  const tenantId = (req.params as { tenantId?: string }).tenantId
  if (!tenantId) throw badRequest('missing_tenant', 'No organization in the request path')

  const membership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: session.userId, tenantId } },
  })
  if (!membership) throw forbidden('not_a_member', 'You do not have access to this organization')

  if (capability) requireMember(membership.role, capability)

  return {
    userId: session.userId,
    tenantId,
    role: membership.role,
    impersonatorAdminId: session.impersonatorAdminId,
  }
}

/** Spec 8.2 Home: the alert strip. */
async function buildAlerts(tenantId: string) {
  const alerts: Array<{ level: 'warning' | 'error'; message: string }> = []

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: { plan: true, subscription: true, domains: true, webhooks: true },
  })

  if (tenant.status !== 'ACTIVE') {
    alerts.push({
      level: 'error',
      message: tenant.statusReason ?? `Account status: ${tenant.status.toLowerCase()}`,
    })
  }

  for (const domain of tenant.domains) {
    if (domain.verifiedAt && (!domain.spfOk || !domain.dkimOk)) {
      alerts.push({ level: 'error', message: `DNS for ${domain.name} has stopped resolving correctly` })
    }
  }

  const limits = planLimits(tenant.plan?.limits)
  if (tenant.subscription && limits.monthlySends > 0) {
    const pct = tenant.subscription.sendsUsed / limits.monthlySends
    if (pct >= 0.8) {
      alerts.push({
        level: pct >= 1 ? 'error' : 'warning',
        message: `You have used ${Math.round(pct * 100)}% of this month's ${limits.monthlySends.toLocaleString()} message allowance`,
      })
    }
  }

  for (const webhook of tenant.webhooks) {
    if (webhook.consecutiveFailures >= 5) {
      alerts.push({
        level: 'warning',
        message: `Webhook ${webhook.url} has failed ${webhook.consecutiveFailures} times in a row`,
      })
    }
  }

  return alerts
}
