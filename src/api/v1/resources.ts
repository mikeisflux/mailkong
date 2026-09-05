import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../db.js'
import { conflict, notFound } from '../../lib/errors.js'
import { addDomain, checkDomain, removeDomain } from '../../services/domains.js'
import { createCredential, revokeCredential } from '../../services/credentials.js'
import { suppress, unsuppress } from '../../services/suppressions.js'
import { planLimits, getQuota } from '../../services/usage.js'
import { WEBHOOK_EVENTS } from '../../services/webhooks.js'
import { encrypt, randomToken } from '../../lib/crypto.js'
import { postalAdmin } from '../../postal/index.js'
import { tenantOf } from '../context.js'

export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- domains

  app.get('/domains', async (req) => {
    const tenant = tenantOf(req)
    const domains = await prisma.domain.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'asc' },
    })
    return { data: domains.map(serializeDomain) }
  })

  app.post('/domains', async (req, reply) => {
    const body = z.object({
      name: z.string().min(3),
      kind: z.enum(['sending', 'tracking', 'inbound']).default('sending'),
    }).parse(req.body)

    const { domain, records } = await addDomain({
      tenantId: tenantOf(req).id,
      name: body.name,
      kind: body.kind.toUpperCase() as 'SENDING' | 'TRACKING' | 'INBOUND',
    })
    reply.code(201)
    return { ...serializeDomain(domain), dns_records: records }
  })

  app.post<{ Params: { id: string } }>('/domains/:id/verify', async (req) => {
    const tenant = tenantOf(req)
    const existing = await prisma.domain.findFirst({ where: { id: req.params.id, tenantId: tenant.id } })
    if (!existing) throw notFound('Domain')
    return serializeDomain(await checkDomain(existing.id))
  })

  app.delete<{ Params: { id: string } }>('/domains/:id', async (req, reply) => {
    const tenant = tenantOf(req)
    const existing = await prisma.domain.findFirst({ where: { id: req.params.id, tenantId: tenant.id } })
    if (!existing) throw notFound('Domain')
    await removeDomain(existing.id)
    reply.code(204)
  })

  // ------------------------------------------------------------ credentials

  app.get('/credentials', async (req) => {
    const credentials = await prisma.credential.findMany({
      where: { tenantId: tenantOf(req).id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    return {
      data: credentials.map((c) => ({
        id: c.id,
        kind: c.kind.toLowerCase(),
        name: c.name,
        prefix: c.prefix,
        last_used_at: c.lastUsedAt?.toISOString() ?? null,
        created_at: c.createdAt.toISOString(),
      })),
    }
  })

  app.post('/credentials', async (req, reply) => {
    const body = z.object({
      kind: z.enum(['api_key', 'smtp']).default('api_key'),
      name: z.string().min(1).max(60),
    }).parse(req.body)

    const created = await createCredential({
      tenantId: tenantOf(req).id,
      kind: body.kind === 'smtp' ? 'SMTP' : 'API_KEY',
      name: body.name,
    })
    reply.code(201)
    // The only response that will ever contain the secret.
    return { ...created, warning: 'Store this secret now. It cannot be retrieved again.' }
  })

  app.delete<{ Params: { id: string } }>('/credentials/:id', async (req, reply) => {
    await revokeCredential(req.params.id, tenantOf(req).id)
    reply.code(204)
  })

  // --------------------------------------------------------------- webhooks

  app.get('/webhooks', async (req) => {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { tenantId: tenantOf(req).id },
      orderBy: { createdAt: 'desc' },
    })
    return { data: endpoints.map(serializeWebhook) }
  })

  app.post('/webhooks', async (req, reply) => {
    const body = z.object({
      url: z.string().url().refine((u) => u.startsWith('https://'), 'Webhook URLs must use HTTPS'),
      events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
    }).parse(req.body)

    const tenant = tenantOf(req)
    const plan = tenant.planId ? await prisma.plan.findUnique({ where: { id: tenant.planId } }) : null
    const limits = planLimits(plan?.limits)
    const count = await prisma.webhookEndpoint.count({ where: { tenantId: tenant.id } })
    if (limits.webhooks >= 0 && count >= limits.webhooks) {
      throw conflict('webhook_limit', `Your plan allows ${limits.webhooks} webhook endpoints`)
    }

    const secret = `whsec_${randomToken(24)}`
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        tenantId: tenant.id,
        url: body.url,
        events: body.events,
        secretEnc: encrypt(secret),
      },
    })
    reply.code(201)
    return { ...serializeWebhook(endpoint), secret, warning: 'Store this signing secret now.' }
  })

  app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req, reply) => {
    const { count } = await prisma.webhookEndpoint.deleteMany({
      where: { id: req.params.id, tenantId: tenantOf(req).id },
    })
    if (count === 0) throw notFound('Webhook endpoint')
    reply.code(204)
  })

  // ----------------------------------------------------------------- routes

  app.get('/routes', async (req) => {
    const routes = await prisma.inboundRoute.findMany({
      where: { tenantId: tenantOf(req).id },
      orderBy: { createdAt: 'desc' },
    })
    return { data: routes.map(serializeRoute) }
  })

  app.post('/routes', async (req, reply) => {
    const body = z.object({
      address: z.string().min(1).max(64),
      domain: z.string().min(3),
      endpoint_url: z.string().url(),
      spam_threshold: z.number().min(0).max(20).optional(),
    }).parse(req.body)

    const tenant = tenantOf(req)
    const plan = tenant.planId ? await prisma.plan.findUnique({ where: { id: tenant.planId } }) : null
    const limits = planLimits(plan?.limits)
    const count = await prisma.inboundRoute.count({ where: { tenantId: tenant.id } })
    if (limits.routes >= 0 && count >= limits.routes) {
      throw conflict('route_limit', `Your plan allows ${limits.routes} inbound routes`)
    }

    const server = await prisma.server.findFirst({ where: { tenantId: tenant.id } })
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
        tenantId: tenant.id,
        serverId: server?.id ?? null,
        postalRouteId,
        address: body.address,
        domain: body.domain,
        endpointUrl: body.endpoint_url,
        spamThreshold: body.spam_threshold ?? null,
      },
    })
    reply.code(201)
    return serializeRoute(route)
  })

  app.delete<{ Params: { id: string } }>('/routes/:id', async (req, reply) => {
    const route = await prisma.inboundRoute.findFirst({
      where: { id: req.params.id, tenantId: tenantOf(req).id },
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

  // ----------------------------------------------------------- suppressions

  app.get('/suppressions', async (req) => {
    const q = z.object({
      limit: z.coerce.number().min(1).max(500).default(100),
      email: z.string().optional(),
    }).parse(req.query)

    const rows = await prisma.suppression.findMany({
      where: {
        OR: [{ tenantId: tenantOf(req).id }, { tenantId: null }],
        ...(q.email ? { email: { contains: q.email.toLowerCase() } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    })
    return {
      data: rows.map((s) => ({
        email: s.email,
        reason: s.reason.toLowerCase(),
        detail: s.detail,
        global: s.tenantId === null,
        created_at: s.createdAt.toISOString(),
      })),
    }
  })

  app.post('/suppressions', async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      reason: z.enum(['hard_bounce', 'complaint', 'manual', 'unsubscribe']).default('manual'),
      detail: z.string().max(500).optional(),
    }).parse(req.body)

    await suppress({
      tenantId: tenantOf(req).id,
      email: body.email,
      reason: body.reason.toUpperCase() as never,
      detail: body.detail,
    })
    reply.code(201)
    return { email: body.email.toLowerCase(), reason: body.reason }
  })

  app.delete<{ Params: { email: string } }>('/suppressions/:email', async (req, reply) => {
    const removed = await unsuppress(tenantOf(req).id, decodeURIComponent(req.params.email))
    if (removed === 0) throw notFound('Suppression')
    reply.code(204)
  })

  // ------------------------------------------------------------------ usage

  app.get('/usage', async (req) => {
    const tenant = tenantOf(req)
    const [quota, plan, days] = await Promise.all([
      getQuota(tenant),
      tenant.planId ? prisma.plan.findUnique({ where: { id: tenant.planId } }) : null,
      prisma.usageDay.findMany({
        where: { tenantId: tenant.id, day: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        orderBy: { day: 'asc' },
      }),
    ])

    return {
      plan: plan ? { key: plan.key, name: plan.name } : null,
      status: tenant.status.toLowerCase(),
      daily: { used: quota.dailyUsed, cap: quota.dailyCap },
      cycle: {
        used: quota.cycleUsed,
        cap: quota.cycleCap,
        ends_at: quota.cycleEnd?.toISOString() ?? null,
      },
      history: days.map((d) => ({
        date: d.day.toISOString().slice(0, 10),
        sent: d.sent,
        delivered: d.delivered,
        bounced: d.bounced,
        failed: d.failed,
        complained: d.complained,
      })),
    }
  })
}

const serializeDomain = (d: {
  id: string
  name: string
  kind: string
  spfOk: boolean
  dkimOk: boolean
  dmarcOk: boolean
  returnPathOk: boolean
  verifiedAt: Date | null
  lastCheckedAt: Date | null
  lastCheckOutput: string | null
  dnsRecords: unknown
}) => ({
  id: d.id,
  name: d.name,
  kind: d.kind.toLowerCase(),
  verified: d.verifiedAt !== null,
  checks: { spf: d.spfOk, dkim: d.dkimOk, dmarc: d.dmarcOk, return_path: d.returnPathOk },
  dns_records: d.dnsRecords ?? [],
  last_checked_at: d.lastCheckedAt?.toISOString() ?? null,
  last_check_output: d.lastCheckOutput,
})

const serializeWebhook = (w: {
  id: string
  url: string
  events: string[]
  enabled: boolean
  lastStatus: number | null
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  consecutiveFailures: number
}) => ({
  id: w.id,
  url: w.url,
  events: w.events,
  enabled: w.enabled,
  last_status: w.lastStatus,
  last_success_at: w.lastSuccessAt?.toISOString() ?? null,
  last_failure_at: w.lastFailureAt?.toISOString() ?? null,
  consecutive_failures: w.consecutiveFailures,
})

const serializeRoute = (r: {
  id: string
  address: string
  domain: string
  endpointUrl: string
  enabled: boolean
  createdAt: Date
}) => ({
  id: r.id,
  address: r.address,
  domain: r.domain,
  endpoint_url: r.endpointUrl,
  enabled: r.enabled,
  created_at: r.createdAt.toISOString(),
})
