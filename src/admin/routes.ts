import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { hashSecret, verifySecret } from '../lib/crypto.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js'
import {
  createAdminSession,
  createSession,
  destroyAdminSession,
  readAdminSession,
} from '../auth/session.js'
import { requireAdmin, type AdminCapability } from '../auth/rbac.js'
import { disableTenant, pauseTenant, resumeTenant } from '../services/provisioning.js'
import { suppress, unsuppress } from '../services/suppressions.js'
import { audit } from '../services/audit.js'
import { postalAdmin } from '../postal/index.js'
import { authenticator } from 'otplib'
import type { AdminUser } from '@prisma/client'
import { userAdminRoutes } from './users.js'

/**
 * Admin console backend for admin.mailkong.net.
 *
 * Spec 9: mandatory 2FA, IP allowlist, and every mutating action written to
 * an immutable audit log. This is how an ESP is operated instead of SSHing
 * into Postal for every customer.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(userAdminRoutes)

  // The allowlist is a network control, applied before authentication so an
  // attacker off-network cannot even probe for valid operator emails.
  app.addHook('onRequest', async (req) => {
    if (config.adminAllowlist.length === 0) return
    if (!config.adminAllowlist.some((cidr) => ipMatches(req.ip, cidr))) {
      throw forbidden('not_allowlisted', 'Admin access is restricted to allowlisted networks')
    }
  })

  app.post('/auth/login', async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string(),
      totp: z.string().length(6).optional(),
    }).parse(req.body)

    const admin = await prisma.adminUser.findUnique({ where: { email: body.email.toLowerCase() } })
    if (!admin || admin.disabledAt) throw unauthorized('Invalid credentials')
    if (!(await verifySecret(admin.passwordHash, body.password))) throw unauthorized('Invalid credentials')

    // Spec 9: 2FA is mandatory. An operator without it enrolled cannot log
    // in at all, rather than being allowed a grace period.
    if (!admin.totpEnabled || !admin.totpSecret) {
      throw forbidden('totp_required', 'Two-factor authentication must be enrolled before signing in')
    }
    if (!body.totp || !authenticator.verify({ token: body.totp, secret: admin.totpSecret })) {
      throw unauthorized('Invalid two-factor code')
    }

    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } })
    await createAdminSession(reply, admin.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
    await audit({ action: 'admin.login', adminId: admin.id, ip: req.ip })
    return { admin: { id: admin.id, email: admin.email, role: admin.role } }
  })

  /**
   * TOTP enrolment.
   *
   * Login requires 2FA, so a freshly seeded operator would otherwise be
   * locked out permanently. Enrolment therefore authenticates with email and
   * password alone -- but only for an account that has no TOTP yet, and it
   * issues no session. An operator who is already enrolled cannot reach this
   * at all, so it can never be used to displace an existing authenticator.
   */
  app.post('/auth/enroll/begin', async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body)
    const admin = await prisma.adminUser.findUnique({ where: { email: body.email.toLowerCase() } })
    if (!admin || admin.disabledAt) throw unauthorized('Invalid credentials')
    if (!(await verifySecret(admin.passwordHash, body.password))) throw unauthorized('Invalid credentials')
    if (admin.totpEnabled) {
      throw conflict('already_enrolled', 'This account already has two-factor enrolled. Ask a superadmin to reset it.')
    }

    const secret = authenticator.generateSecret()
    // Held unconfirmed: totpEnabled stays false until a valid code proves the
    // authenticator actually holds this secret.
    await prisma.adminUser.update({ where: { id: admin.id }, data: { totpSecret: secret } })

    return {
      secret,
      otpauth_url: authenticator.keyuri(admin.email, 'Mailkong Ops', secret),
    }
  })

  app.post('/auth/enroll/confirm', async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string(),
      totp: z.string().length(6),
    }).parse(req.body)

    const admin = await prisma.adminUser.findUnique({ where: { email: body.email.toLowerCase() } })
    if (!admin?.totpSecret || admin.totpEnabled) throw unauthorized('Nothing to confirm')
    if (!(await verifySecret(admin.passwordHash, body.password))) throw unauthorized('Invalid credentials')
    if (!authenticator.verify({ token: body.totp, secret: admin.totpSecret })) {
      throw unauthorized('That code did not match. Check your device clock and try again.')
    }

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { totpEnabled: true, lastLoginAt: new Date() },
    })
    await createAdminSession(reply, admin.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
    await audit({ action: 'admin.totp_enrolled', adminId: admin.id, ip: req.ip })
    return { admin: { id: admin.id, email: admin.email, role: admin.role } }
  })

  app.post('/auth/logout', async (req, reply) => {
    await destroyAdminSession(req, reply)
    return { ok: true }
  })

  app.get('/me', async (req) => {
    const admin = await requireOperator(req)
    return { id: admin.id, email: admin.email, name: admin.name, role: admin.role }
  })

  // ------------------------------------------------------- ops overview

  app.get('/overview', async (req) => {
    await requireOperator(req)
    const hourAgo = new Date(Date.now() - 3_600_000)
    const dayAgo = new Date(Date.now() - 86_400_000)

    const [lastHour, lastDay, byStatus, overCap, paused, openAbuse, pools, postalUp] =
      await Promise.all([
        prisma.message.count({ where: { createdAt: { gte: hourAgo } } }),
        prisma.message.count({ where: { createdAt: { gte: dayAgo } } }),
        prisma.message.groupBy({
          by: ['status'],
          where: { createdAt: { gte: dayAgo } },
          _count: { _all: true },
        }),
        prisma.tenant.count({ where: { status: 'PAST_DUE' } }),
        prisma.tenant.count({ where: { status: 'PAUSED' } }),
        prisma.abuseTicket.count({ where: { status: { in: ['NEW', 'INVESTIGATING'] } } }),
        prisma.ipPool.findMany({ include: { addresses: true, _count: { select: { servers: true } } } }),
        postalAdmin.reachable(),
      ])

    const total = byStatus.reduce((n, r) => n + r._count._all, 0)
    const bounced = byStatus.find((r) => r.status === 'BOUNCED')?._count._all ?? 0
    const held = byStatus.find((r) => r.status === 'HELD')?._count._all ?? 0

    return {
      sends: { last_hour: lastHour, last_24h: lastDay },
      health: {
        bounce_rate: total > 0 ? bounced / total : 0,
        held,
        postal_reachable: postalUp,
      },
      accounts: { past_due: overCap, paused, open_abuse: openAbuse },
      pools: pools.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        addresses: p.addresses.length,
        servers: p._count.servers,
        warming: p.addresses.filter((a) => a.warming).length,
      })),
    }
  })

  // ----------------------------------------------------------- tenants

  app.get('/tenants', async (req) => {
    await requireOperator(req)
    const q = z.object({
      search: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50),
    }).parse(req.query)

    const tenants = await prisma.tenant.findMany({
      where: {
        ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { slug: { contains: q.search, mode: 'insensitive' } },
                { postalOrgId: { contains: q.search } },
                { domains: { some: { name: { contains: q.search.toLowerCase() } } } },
                { memberships: { some: { user: { email: { contains: q.search.toLowerCase() } } } } },
              ],
            }
          : {}),
      },
      include: { plan: true, subscription: true, _count: { select: { domains: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    })

    return {
      data: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        status_reason: t.statusReason,
        plan: t.plan?.key ?? null,
        sends_this_cycle: t.subscription?.sendsUsed ?? 0,
        daily_cap: t.dailyCap,
        domains: t._count.domains,
        tags: t.tags,
        created_at: t.createdAt,
      })),
    }
  })

  app.get<{ Params: { id: string } }>('/tenants/:id', async (req) => {
    await requireOperator(req)
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        plan: true,
        subscription: true,
        domains: true,
        servers: { include: { ipPool: true } },
        webhooks: true,
        memberships: { include: { user: { select: { id: true, email: true, name: true } } } },
        usageDays: { orderBy: { day: 'desc' }, take: 30 },
      },
    })
    if (!tenant) throw notFound('Tenant')

    const recent = await prisma.message.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      take: 25,
    })

    return { tenant, recent_messages: recent }
  })

  app.post<{ Params: { id: string } }>('/tenants/:id/pause', async (req) => {
    const admin = await requireOperator(req, 'tenant:pause')
    const body = z.object({ reason: z.string().min(3).max(300) }).parse(req.body)
    await pauseTenant(req.params.id, body.reason, { adminId: admin.id })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/tenants/:id/resume', async (req) => {
    const admin = await requireOperator(req, 'tenant:pause')
    await resumeTenant(req.params.id, admin.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/tenants/:id/disable', async (req) => {
    const admin = await requireOperator(req, 'tenant:pause')
    const body = z.object({ reason: z.string().min(3).max(300) }).parse(req.body)
    await disableTenant(req.params.id, body.reason, admin.id)
    return { ok: true }
  })

  app.patch<{ Params: { id: string } }>('/tenants/:id', async (req) => {
    const admin = await requireOperator(req, 'tenant:pause')
    const body = z.object({
      daily_cap: z.number().min(0).max(10_000_000).optional(),
      plan_key: z.string().optional(),
      notes: z.string().max(5000).optional(),
      tags: z.array(z.string().max(30)).max(10).optional(),
    }).parse(req.body)

    const plan = body.plan_key
      ? await prisma.plan.findUnique({ where: { key: body.plan_key } })
      : null
    if (body.plan_key && !plan) throw badRequest('unknown_plan', `No plan with key "${body.plan_key}"`)

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: {
        ...(body.daily_cap !== undefined ? { dailyCap: body.daily_cap } : {}),
        ...(plan ? { planId: plan.id } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
      },
    })

    await audit({
      action: 'tenant.updated',
      adminId: admin.id,
      tenantId: tenant.id,
      payload: body,
      ip: req.ip,
    })
    return tenant
  })

  /**
   * Impersonation, spec 9.2. Creates a customer session for the tenant owner
   * that records which operator opened it, so the dashboard can render the
   * "you are viewing as" banner and the audit log can attribute anything
   * done while impersonating.
   */
  app.post<{ Params: { id: string } }>('/tenants/:id/impersonate', async (req, reply) => {
    const admin = await requireOperator(req, 'tenant:impersonate')
    const owner = await prisma.membership.findFirst({
      where: { tenantId: req.params.id, role: 'OWNER' },
      include: { user: true },
    })
    if (!owner) throw notFound('Tenant owner')

    await createSession(reply, owner.userId, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      impersonatorAdminId: admin.id,
    })
    await audit({
      action: 'tenant.impersonated',
      adminId: admin.id,
      tenantId: req.params.id,
      payload: { asUserId: owner.userId, asEmail: owner.user.email },
      ip: req.ip,
    })
    return { app_url: config.APP_URL, as: owner.user.email }
  })

  // ------------------------------------------------- global message search

  app.get('/messages', async (req) => {
    await requireOperator(req, 'messages:read')
    const q = z.object({
      search: z.string().min(2),
      limit: z.coerce.number().min(1).max(200).default(50),
    }).parse(req.query)

    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { to: { contains: q.search, mode: 'insensitive' } },
          { from: { contains: q.search, mode: 'insensitive' } },
          { postalMessageId: q.search },
          { token: q.search },
          { id: q.search },
        ],
      },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    })
    return { data: messages }
  })

  // ------------------------------------------------------------ IP pools

  app.get('/pools', async (req) => {
    await requireOperator(req)
    return {
      data: await prisma.ipPool.findMany({
        include: { addresses: true, tenant: { select: { id: true, name: true } }, servers: true },
      }),
    }
  })

  app.post('/pools', async (req, reply) => {
    const admin = await requireOperator(req, 'pool:write')
    const body = z.object({
      name: z.string().min(2).max(60),
      kind: z.enum(['SHARED_TX', 'SHARED_MKT', 'DEDICATED']),
      tenant_id: z.string().optional(),
    }).parse(req.body)

    const postalPool = await postalAdmin.createIpPool(body.name).catch(() => null)
    const pool = await prisma.ipPool.create({
      data: {
        name: body.name,
        kind: body.kind,
        tenantId: body.tenant_id ?? null,
        postalPoolId: postalPool ? String(postalPool.id) : null,
      },
    })
    await audit({ action: 'pool.created', adminId: admin.id, payload: body, ip: req.ip })
    reply.code(201)
    return pool
  })

  app.post<{ Params: { id: string } }>('/pools/:id/addresses', async (req, reply) => {
    const admin = await requireOperator(req, 'pool:write')
    const body = z.object({
      address: z.string().ip({ version: 'v4' }),
      ptr: z.string().min(3),
      daily_cap: z.number().min(0).optional(),
    }).parse(req.body)

    const pool = await prisma.ipPool.findUnique({ where: { id: req.params.id } })
    if (!pool) throw notFound('Pool')

    await postalAdmin
      .addIpToPool(pool.name, { ipv4: body.address, hostname: body.ptr })
      .catch(() => undefined)

    const ip = await prisma.ipAddress.create({
      data: {
        poolId: pool.id,
        address: body.address,
        ptr: body.ptr,
        // New IPs always start warming with a manual cap (spec 9.2).
        warming: true,
        dailyCap: body.daily_cap ?? 500,
      },
    })
    await audit({ action: 'pool.ip_added', adminId: admin.id, payload: body, ip: req.ip })
    reply.code(201)
    return ip
  })

  app.post<{ Params: { id: string } }>('/tenants/:id/dedicated-ip', async (req) => {
    const admin = await requireOperator(req, 'pool:write')
    const body = z.object({
      address: z.string().ip({ version: 'v4' }),
      ptr: z.string().min(3),
    }).parse(req.body)

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: { servers: true },
    })
    if (!tenant) throw notFound('Tenant')

    // Spec 11 "dedicated IP approved": pool, IP, move the server, mark warming.
    const name = `dedicated-${tenant.slug}`
    const postalPool = await postalAdmin.createIpPool(name).catch(() => null)
    const pool = await prisma.ipPool.create({
      data: {
        name,
        kind: 'DEDICATED',
        tenantId: tenant.id,
        postalPoolId: postalPool ? String(postalPool.id) : null,
      },
    })

    await postalAdmin.addIpToPool(name, { ipv4: body.address, hostname: body.ptr }).catch(() => undefined)
    await prisma.ipAddress.create({
      data: { poolId: pool.id, address: body.address, ptr: body.ptr, warming: true, dailyCap: 500 },
    })

    for (const server of tenant.servers) {
      if (server.postalPermalink) {
        await postalAdmin.updateServer(server.postalPermalink, { ipPoolName: name }).catch(() => undefined)
      }
      await prisma.server.update({ where: { id: server.id }, data: { ipPoolId: pool.id } })
    }

    await audit({
      action: 'tenant.dedicated_ip_provisioned',
      adminId: admin.id,
      tenantId: tenant.id,
      payload: body,
      ip: req.ip,
    })
    return { pool, warming: true }
  })

  // ------------------------------------------------------ global domains

  /** Spec 9.1 /domains: every customer domain, filterable by health. */
  app.get('/domains', async (req) => {
    await requireOperator(req)
    const q = z.object({
      search: z.string().optional(),
      state: z.enum(['all', 'verified', 'unverified', 'broken']).default('all'),
      limit: z.coerce.number().min(1).max(500).default(100),
    }).parse(req.query)

    const domains = await prisma.domain.findMany({
      where: {
        ...(q.search ? { name: { contains: q.search.toLowerCase() } } : {}),
        ...(q.state === 'verified' ? { verifiedAt: { not: null } } : {}),
        ...(q.state === 'unverified' ? { verifiedAt: null } : {}),
        // "Broken" is the case worth an operator's attention: it verified
        // once and no longer does, so the customer's mail is failing now.
        ...(q.state === 'broken'
          ? { verifiedAt: null, lastCheckOutput: { not: null }, lastCheckedAt: { not: null } }
          : {}),
      },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
      orderBy: { lastCheckedAt: { sort: 'desc', nulls: 'last' } },
      take: q.limit,
    })

    return {
      data: domains.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        tenant: d.tenant,
        spf: d.spfOk,
        dkim: d.dkimOk,
        dmarc: d.dmarcOk,
        verified: d.verifiedAt !== null,
        last_checked_at: d.lastCheckedAt,
        last_check_output: d.lastCheckOutput,
      })),
    }
  })

  // ------------------------------------------------------- queues + health

  /**
   * Spec 9.2 Queues + health. Everything an operator checks when something
   * feels wrong, on one screen, so the answer to "is it us" takes seconds.
   */
  app.get('/health/detail', async (req) => {
    await requireOperator(req)
    const hourAgo = new Date(Date.now() - 3_600_000)
    const dayAgo = new Date(Date.now() - 86_400_000)

    const [postalQueue, postalUp, webhookFailures, webhookTotal, stuck, dbSize, oldestQueued, disabledHooks] =
      await Promise.all([
        postalAdmin.queueStats().catch(() => null),
        postalAdmin.reachable(),
        prisma.webhookDelivery.count({ where: { createdAt: { gte: hourAgo }, succeededAt: null } }),
        prisma.webhookDelivery.count({ where: { createdAt: { gte: hourAgo } } }),
        // Anything still queued after an hour is not queued, it is stuck.
        prisma.message.count({ where: { status: 'QUEUED', createdAt: { lt: hourAgo } } }),
        prisma.$queryRaw<Array<{ size: string; bytes: bigint }>>`
          SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
                 pg_database_size(current_database()) AS bytes`,
        prisma.message.findFirst({
          where: { status: 'QUEUED' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        prisma.webhookEndpoint.count({ where: { enabled: false } }),
      ])

    const messages24h = await prisma.message.count({ where: { createdAt: { gte: dayAgo } } })

    return {
      postal: {
        reachable: postalUp,
        queued: postalQueue?.queued ?? null,
        held: postalQueue?.held ?? null,
        workers: postalQueue?.workers ?? null,
      },
      control_plane: {
        messages_24h: messages24h,
        stuck_queued: stuck,
        oldest_queued_at: oldestQueued?.createdAt ?? null,
        database_size: dbSize[0]?.size ?? null,
        database_bytes: Number(dbSize[0]?.bytes ?? 0),
      },
      webhooks: {
        attempts_last_hour: webhookTotal,
        failures_last_hour: webhookFailures,
        failure_rate: webhookTotal > 0 ? webhookFailures / webhookTotal : 0,
        disabled_endpoints: disabledHooks,
      },
      // Thresholds live here rather than in the UI so the alerting job and
      // the dashboard cannot disagree about what "bad" means.
      alerts: buildHealthAlerts({
        postalUp,
        postalQueued: postalQueue?.queued ?? 0,
        workers: postalQueue?.workers ?? 0,
        stuck,
        webhookFailureRate: webhookTotal > 0 ? webhookFailures / webhookTotal : 0,
        databaseBytes: Number(dbSize[0]?.bytes ?? 0),
      }),
    }
  })

  // -------------------------------------------------------------- abuse

  app.get('/abuse', async (req) => {
    await requireOperator(req)
    return {
      data: await prisma.abuseTicket.findMany({
        where: { status: { in: ['NEW', 'INVESTIGATING'] } },
        include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    }
  })

  app.patch<{ Params: { id: string } }>('/abuse/:id', async (req) => {
    const admin = await requireOperator(req, 'abuse:write')
    const body = z.object({
      status: z.enum(['NEW', 'INVESTIGATING', 'RESOLVED']),
      resolution: z.string().max(2000).optional(),
    }).parse(req.body)

    const ticket = await prisma.abuseTicket.update({
      where: { id: req.params.id },
      data: { status: body.status, resolution: body.resolution ?? null, assignedTo: admin.id },
    })
    await audit({
      action: 'abuse.updated',
      adminId: admin.id,
      tenantId: ticket.tenantId,
      payload: body,
      ip: req.ip,
    })
    return ticket
  })

  // -------------------------------------------------- global suppressions

  app.post('/suppressions', async (req, reply) => {
    const admin = await requireOperator(req, 'abuse:write')
    const body = z.object({
      email: z.string().email(),
      tenant_id: z.string().nullable().default(null),
      reason: z.enum(['HARD_BOUNCE', 'COMPLAINT', 'MANUAL']).default('MANUAL'),
    }).parse(req.body)

    await suppress({ tenantId: body.tenant_id, email: body.email, reason: body.reason })
    await audit({ action: 'suppression.added', adminId: admin.id, payload: body, ip: req.ip })
    reply.code(201)
    return { ok: true }
  })

  app.delete<{ Params: { email: string } }>('/suppressions/:email', async (req, reply) => {
    const admin = await requireOperator(req, 'abuse:write')
    await unsuppress(null, decodeURIComponent(req.params.email))
    await audit({ action: 'suppression.removed', adminId: admin.id, ip: req.ip })
    reply.code(204)
  })

  // --------------------------------------------------------- plans, system

  app.get('/plans', async (req) => {
    await requireOperator(req)
    return { data: await prisma.plan.findMany({ orderBy: { monthlyPrice: 'asc' } }) }
  })

  app.put<{ Params: { key: string } }>('/plans/:key', async (req) => {
    const admin = await requireOperator(req, 'plans:write')
    const body = z.object({
      name: z.string(),
      monthly_price: z.number().min(0),
      limits: z.record(z.unknown()),
      hard_stop: z.boolean().default(true),
      public: z.boolean().default(true),
      stripe_price_id: z.string().nullable().optional(),
    }).parse(req.body)

    const plan = await prisma.plan.upsert({
      where: { key: req.params.key },
      create: {
        key: req.params.key,
        name: body.name,
        monthlyPrice: body.monthly_price,
        limits: body.limits as never,
        hardStop: body.hard_stop,
        public: body.public,
        stripePriceId: body.stripe_price_id ?? null,
      },
      update: {
        name: body.name,
        monthlyPrice: body.monthly_price,
        limits: body.limits as never,
        hardStop: body.hard_stop,
        public: body.public,
        stripePriceId: body.stripe_price_id ?? null,
      },
    })
    await audit({ action: 'plan.updated', adminId: admin.id, payload: body, ip: req.ip })
    return plan
  })

  app.get('/system', async (req) => {
    await requireOperator(req)
    const [flags, queue, postalUp] = await Promise.all([
      prisma.featureFlag.findMany(),
      postalAdmin.queueStats().catch(() => null),
      postalAdmin.reachable(),
    ])
    return { flags, queue, postal_reachable: postalUp }
  })

  app.put<{ Params: { key: string } }>('/system/flags/:key', async (req) => {
    const admin = await requireOperator(req, 'system:write')
    const body = z.object({ enabled: z.boolean(), value: z.unknown().optional() }).parse(req.body)
    const flag = await prisma.featureFlag.upsert({
      where: { key: req.params.key },
      create: { key: req.params.key, enabled: body.enabled, value: (body.value ?? null) as never },
      update: { enabled: body.enabled, value: (body.value ?? null) as never },
    })
    await audit({
      action: 'system.flag_changed',
      adminId: admin.id,
      payload: { key: req.params.key, ...body },
      ip: req.ip,
    })
    return flag
  })

  // ---------------------------------------------------------- audit log

  app.get('/audit', async (req) => {
    await requireOperator(req)
    const q = z.object({
      tenant_id: z.string().optional(),
      action: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(100),
    }).parse(req.query)

    return {
      data: await prisma.auditEvent.findMany({
        where: {
          ...(q.tenant_id ? { tenantId: q.tenant_id } : {}),
          ...(q.action ? { action: { contains: q.action } } : {}),
        },
        include: {
          admin: { select: { id: true, email: true } },
          tenant: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
      }),
    }
  })
}

async function requireOperator(req: FastifyRequest, capability?: AdminCapability): Promise<AdminUser> {
  const admin = await readAdminSession(req)
  if (!admin) throw unauthorized('Operator sign-in required')
  if (capability) requireAdmin(admin.role, capability)
  return admin
}

export interface HealthInput {
  postalUp: boolean
  postalQueued: number
  workers: number
  stuck: number
  webhookFailureRate: number
  databaseBytes: number
}

/**
 * The thresholds that define "page someone". Exported so the alerting job in
 * jobs/health.ts uses exactly these, and the console and the pager can never
 * disagree about whether something is wrong.
 */
export function buildHealthAlerts(h: HealthInput): Array<{ level: 'warning' | 'critical'; message: string }> {
  const alerts: Array<{ level: 'warning' | 'critical'; message: string }> = []

  if (!h.postalUp) {
    alerts.push({ level: 'critical', message: 'Postal is unreachable. Sending and provisioning are both down.' })
  }
  if (h.postalUp && h.workers === 0) {
    alerts.push({ level: 'critical', message: 'Postal reports no live workers. Mail is queueing and nothing is draining it.' })
  }
  if (h.postalQueued > 5000) {
    alerts.push({ level: 'critical', message: `Postal queue depth is ${h.postalQueued.toLocaleString()}.` })
  } else if (h.postalQueued > 1000) {
    alerts.push({ level: 'warning', message: `Postal queue depth is ${h.postalQueued.toLocaleString()} and climbing.` })
  }
  if (h.stuck > 0) {
    alerts.push({
      level: h.stuck > 100 ? 'critical' : 'warning',
      message: `${h.stuck} message(s) have been queued for over an hour. Check that Postal is accepting from the control plane.`,
    })
  }
  if (h.webhookFailureRate > 0.5) {
    alerts.push({ level: 'warning', message: `${Math.round(h.webhookFailureRate * 100)}% of webhook deliveries failed in the last hour.` })
  }
  // Box B's disk is the documented growth ceiling; the control-plane database
  // filling is a different and much earlier problem.
  const gb = h.databaseBytes / 1_000_000_000
  if (gb > 40) {
    alerts.push({ level: 'critical', message: `The control-plane database is ${gb.toFixed(1)} GB. Check message retention pruning.` })
  } else if (gb > 20) {
    alerts.push({ level: 'warning', message: `The control-plane database is ${gb.toFixed(1)} GB.` })
  }

  return alerts
}

/** Supports plain addresses and CIDR notation. IPv4 only, which is what OVH gives us. */
function ipMatches(ip: string, cidr: string): boolean {
  const clean = ip.replace(/^::ffff:/, '')
  if (!cidr.includes('/')) return clean === cidr
  const [range, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  if (!range || Number.isNaN(bits)) return false
  const toInt = (a: string) =>
    a.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (toInt(clean) & mask) === (toInt(range) & mask)
}
