import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { hashSecret, randomToken, sha256 } from '../lib/crypto.js'
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js'
import { readAdminSession } from '../auth/session.js'
import { requireAdmin, type AdminCapability } from '../auth/rbac.js'
import { audit } from '../services/audit.js'
import { sendPlatformMail } from '../mail/mailer.js'
import { templates } from '../mail/templates.js'
import type { AdminUser } from '@prisma/client'

/**
 * Operator and customer-user administration.
 *
 * Two rules shape everything here:
 *
 *   An operator can never be handed a password. Support resets go out as a
 *   single-use link to the customer's own inbox, so nobody in this building
 *   ever knows a customer's credential.
 *
 *   Privilege cannot be escalated sideways. Only a superadmin may create or
 *   change operators, nobody may disable or demote themselves, and the last
 *   superadmin cannot be removed -- otherwise the console locks everyone out
 *   permanently.
 */
export async function userAdminRoutes(app: FastifyInstance): Promise<void> {
  // ==================================================== customer users

  app.get('/users', async (req) => {
    await operator(req, 'users:read')
    const q = z.object({
      search: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }).parse(req.query)

    const users = await prisma.user.findMany({
      where: q.search
        ? {
            OR: [
              { email: { contains: q.search.toLowerCase(), mode: 'insensitive' } },
              { name: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      include: {
        memberships: {
          include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
        },
        _count: { select: { sessions: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    })

    const hasMore = users.length > q.limit
    return {
      data: (hasMore ? users.slice(0, q.limit) : users).map(serializeUser),
      has_more: hasMore,
    }
  })

  app.get<{ Params: { id: string } }>('/users/:id', async (req) => {
    await operator(req, 'users:read')
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        memberships: {
          include: { tenant: { select: { id: true, name: true, slug: true, status: true, planId: true } } },
        },
        sessions: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    })
    if (!user) throw notFound('User')

    const recentActions = await prisma.auditEvent.findMany({
      where: { actorId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    return {
      user: {
        ...serializeUser({ ...user, _count: { sessions: user.sessions.length } }),
        has_password: user.passwordHash !== null,
        sessions: user.sessions.map((s) => ({
          id: s.id.slice(0, 8),
          ip: s.ip,
          user_agent: s.userAgent,
          impersonated: s.impersonatorAdminId !== null,
          created_at: s.createdAt,
          expires_at: s.expiresAt,
        })),
      },
      recent_actions: recentActions,
    }
  })

  app.patch<{ Params: { id: string } }>('/users/:id', async (req) => {
    const admin = await operator(req, 'users:write')
    const body = z.object({
      name: z.string().min(1).max(80).nullable().optional(),
      email: z.string().email().optional(),
      email_verified: z.boolean().optional(),
    }).parse(req.body)

    const user = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!user) throw notFound('User')

    if (body.email && body.email.toLowerCase() !== user.email) {
      const taken = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })
      if (taken) throw conflict('email_taken', 'Another account already uses that address')
    }

    const emailChanged = body.email !== undefined && body.email.toLowerCase() !== user.email

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.email ? { email: body.email.toLowerCase() } : {}),
        // Moving the address invalidates the proof we had for the old one.
        ...(emailChanged ? { emailVerified: false } : {}),
        ...(body.email_verified !== undefined && !emailChanged
          ? { emailVerified: body.email_verified }
          : {}),
      },
    })

    await audit({
      action: 'user.updated',
      adminId: admin.id,
      payload: { userId: user.id, from: user.email, to: updated.email, changes: body },
      ip: req.ip,
    })
    return serializeUser({ ...updated, memberships: [], _count: { sessions: 0 } })
  })

  /**
   * Support-initiated password reset.
   *
   * Deliberately sends a link rather than setting a password: an operator who
   * could set one could then sign in as the customer without impersonation
   * being recorded.
   */
  app.post<{ Params: { id: string } }>('/users/:id/send-reset', async (req) => {
    const admin = await operator(req, 'users:write')
    const user = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!user) throw notFound('User')

    const token = randomToken()
    await prisma.loginToken.deleteMany({ where: { userId: user.id, purpose: 'password_reset', usedAt: null } })
    await prisma.loginToken.create({
      data: {
        userId: user.id,
        purpose: 'password_reset',
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })

    const delivered = await sendPlatformMail({
      to: user.email,
      ...templates.passwordReset({ url: `${config.APP_URL}/reset/${token}` }),
    })

    await audit({
      action: 'user.reset_sent',
      adminId: admin.id,
      payload: { userId: user.id, email: user.email, delivered },
      ip: req.ip,
    })

    return {
      delivered,
      // Surfaced so support can read the link out when platform email is not
      // yet working -- which is the case until the internal tenant exists.
      manual_link: delivered ? null : `${config.APP_URL}/reset/${token}`,
    }
  })

  app.post<{ Params: { id: string } }>('/users/:id/revoke-sessions', async (req) => {
    const admin = await operator(req, 'users:write')
    const { count } = await prisma.session.deleteMany({ where: { userId: req.params.id } })
    await audit({
      action: 'user.sessions_revoked',
      adminId: admin.id,
      payload: { userId: req.params.id, count },
      ip: req.ip,
    })
    return { revoked: count }
  })

  app.patch<{ Params: { id: string; membershipId: string } }>(
    '/users/:id/memberships/:membershipId',
    async (req) => {
      const admin = await operator(req, 'users:write')
      const body = z.object({ role: z.enum(['OWNER', 'ADMIN', 'DEVELOPER', 'READ_ONLY']) }).parse(req.body)

      const membership = await prisma.membership.findFirst({
        where: { id: req.params.membershipId, userId: req.params.id },
      })
      if (!membership) throw notFound('Membership')

      if (membership.role === 'OWNER' && body.role !== 'OWNER') {
        const owners = await prisma.membership.count({
          where: { tenantId: membership.tenantId, role: 'OWNER' },
        })
        if (owners <= 1) {
          throw conflict('last_owner', 'This is the tenant\'s only owner. Promote someone else first.')
        }
      }

      const updated = await prisma.membership.update({
        where: { id: membership.id },
        data: { role: body.role },
      })
      await audit({
        action: 'user.membership_changed',
        adminId: admin.id,
        tenantId: membership.tenantId,
        payload: { userId: req.params.id, from: membership.role, to: body.role },
        ip: req.ip,
      })
      return updated
    },
  )

  app.delete<{ Params: { id: string; membershipId: string } }>(
    '/users/:id/memberships/:membershipId',
    async (req, reply) => {
      const admin = await operator(req, 'users:write')
      const membership = await prisma.membership.findFirst({
        where: { id: req.params.membershipId, userId: req.params.id },
      })
      if (!membership) throw notFound('Membership')

      if (membership.role === 'OWNER') {
        const owners = await prisma.membership.count({
          where: { tenantId: membership.tenantId, role: 'OWNER' },
        })
        if (owners <= 1) {
          throw conflict('last_owner', 'A tenant must always have an owner')
        }
      }

      await prisma.$transaction([
        prisma.membership.delete({ where: { id: membership.id } }),
        prisma.session.deleteMany({ where: { userId: req.params.id } }),
      ])
      await audit({
        action: 'user.membership_removed',
        adminId: admin.id,
        tenantId: membership.tenantId,
        payload: { userId: req.params.id },
        ip: req.ip,
      })
      reply.code(204)
    },
  )

  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const admin = await operator(req, 'users:delete')
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { memberships: true },
    })
    if (!user) throw notFound('User')

    // Deleting someone who solely owns a tenant would orphan it: no one could
    // reach its billing or close it. Make the operator resolve that first.
    for (const membership of user.memberships) {
      if (membership.role !== 'OWNER') continue
      const owners = await prisma.membership.count({
        where: { tenantId: membership.tenantId, role: 'OWNER' },
      })
      if (owners <= 1) {
        const tenant = await prisma.tenant.findUnique({ where: { id: membership.tenantId } })
        throw conflict(
          'sole_owner',
          `This user is the only owner of "${tenant?.name ?? membership.tenantId}". Transfer ownership or disable that tenant first.`,
        )
      }
    }

    await prisma.user.delete({ where: { id: user.id } })
    await audit({
      action: 'user.deleted',
      adminId: admin.id,
      payload: { userId: user.id, email: user.email },
      ip: req.ip,
    })
    reply.code(204)
  })

  // ========================================================== operators

  app.get('/operators', async (req) => {
    await operator(req, 'operators:read')
    const operators = await prisma.adminUser.findMany({
      orderBy: [{ disabledAt: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { sessions: true, auditEvents: true } } },
    })
    return {
      data: operators.map((o) => ({
        id: o.id,
        email: o.email,
        name: o.name,
        role: o.role,
        totp_enabled: o.totpEnabled,
        disabled: o.disabledAt !== null,
        last_login_at: o.lastLoginAt,
        active_sessions: o._count.sessions,
        actions_logged: o._count.auditEvents,
        created_at: o.createdAt,
      })),
    }
  })

  app.post('/operators', async (req, reply) => {
    const admin = await operator(req, 'operators:write')
    const body = z.object({
      email: z.string().email(),
      name: z.string().min(1).max(80),
      role: z.enum(['SUPERADMIN', 'SUPPORT', 'BILLING', 'READ_ONLY']),
    }).parse(req.body)

    const email = body.email.toLowerCase()
    if (await prisma.adminUser.findUnique({ where: { email } })) {
      throw conflict('operator_exists', 'An operator with that email already exists')
    }

    // A temporary password shown once to the creating superadmin, who passes
    // it on out of band. The new operator cannot sign in until they enrol
    // TOTP, so the temporary password alone is not access.
    const temporary = `tmp_${randomToken(18)}`
    const created = await prisma.adminUser.create({
      data: { email, name: body.name, role: body.role, passwordHash: await hashSecret(temporary) },
    })

    await audit({
      action: 'operator.created',
      adminId: admin.id,
      payload: { operatorId: created.id, email, role: body.role },
      ip: req.ip,
    })

    reply.code(201)
    return {
      id: created.id,
      email: created.email,
      role: created.role,
      temporary_password: temporary,
      note: 'Shown once. They must enrol two-factor authentication before they can sign in.',
    }
  })

  app.patch<{ Params: { id: string } }>('/operators/:id', async (req) => {
    const admin = await operator(req, 'operators:write')
    const body = z.object({
      name: z.string().min(1).max(80).optional(),
      role: z.enum(['SUPERADMIN', 'SUPPORT', 'BILLING', 'READ_ONLY']).optional(),
      disabled: z.boolean().optional(),
    }).parse(req.body)

    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id } })
    if (!target) throw notFound('Operator')

    // Self-demotion and self-disabling are how an operator accidentally locks
    // themselves out mid-incident.
    if (target.id === admin.id && (body.role !== undefined || body.disabled === true)) {
      throw badRequest('self_change', 'You cannot change your own role or disable your own account')
    }

    await assertNotLastSuperadmin(target, {
      losingRole: body.role !== undefined && body.role !== 'SUPERADMIN',
      beingDisabled: body.disabled === true,
    })

    const updated = await prisma.adminUser.update({
      where: { id: target.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.disabled !== undefined
          ? { disabledAt: body.disabled ? new Date() : null }
          : {}),
      },
    })

    // Disabling must take effect now, not when their session expires.
    if (body.disabled === true) {
      await prisma.adminSession.deleteMany({ where: { adminId: target.id } })
    }

    await audit({
      action: 'operator.updated',
      adminId: admin.id,
      payload: { operatorId: target.id, email: target.email, changes: body },
      ip: req.ip,
    })
    return { id: updated.id, email: updated.email, role: updated.role, disabled: updated.disabledAt !== null }
  })

  app.post<{ Params: { id: string } }>('/operators/:id/reset-password', async (req) => {
    const admin = await operator(req, 'operators:write')
    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id } })
    if (!target) throw notFound('Operator')

    const temporary = `tmp_${randomToken(18)}`
    await prisma.$transaction([
      prisma.adminUser.update({
        where: { id: target.id },
        data: { passwordHash: await hashSecret(temporary) },
      }),
      prisma.adminSession.deleteMany({ where: { adminId: target.id } }),
    ])

    await audit({
      action: 'operator.password_reset',
      adminId: admin.id,
      payload: { operatorId: target.id, email: target.email },
      ip: req.ip,
    })
    return { temporary_password: temporary, note: 'Shown once. Their sessions have been ended.' }
  })

  app.delete<{ Params: { id: string } }>('/operators/:id', async (req, reply) => {
    const admin = await operator(req, 'operators:write')
    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id } })
    if (!target) throw notFound('Operator')

    if (target.id === admin.id) {
      throw badRequest('self_delete', 'You cannot delete your own operator account')
    }
    await assertNotLastSuperadmin(target, { beingDeleted: true })

    // The audit log outlives the operator: `admin_id` is nullable and the
    // email is copied into the payload, so who did what survives deletion.
    await audit({
      action: 'operator.deleted',
      adminId: admin.id,
      payload: { operatorId: target.id, email: target.email, role: target.role },
      ip: req.ip,
    })
    await prisma.adminUser.delete({ where: { id: target.id } })
    reply.code(204)
  })

  /**
   * Clearing someone else's 2FA lets them re-enrol on a new device. It does
   * not grant access on its own: they still need their password, and login
   * refuses an account with no TOTP enrolled.
   */
  app.post<{ Params: { id: string } }>('/operators/:id/reset-totp', async (req) => {
    const admin = await operator(req, 'operators:write')
    const target = await prisma.adminUser.update({
      where: { id: req.params.id },
      data: { totpSecret: null, totpEnabled: false },
    })
    await prisma.adminSession.deleteMany({ where: { adminId: target.id } })
    await audit({
      action: 'operator.totp_reset',
      adminId: admin.id,
      payload: { operatorId: target.id, email: target.email },
      ip: req.ip,
    })
    return { ok: true }
  })

  /** Self-service password change for the signed-in operator. */
  app.post('/operators/me/password', async (req) => {
    const admin = await operator(req)
    const body = z.object({
      current: z.string(),
      next: z.string().min(12, 'Use at least 12 characters'),
    }).parse(req.body)

    const { verifySecret } = await import('../lib/crypto.js')
    if (!(await verifySecret(admin.passwordHash, body.current))) {
      throw unauthorized('Current password is incorrect')
    }

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash: await hashSecret(body.next) },
    })
    await audit({ action: 'operator.self_password_changed', adminId: admin.id, ip: req.ip })
    return { ok: true }
  })
}

// ------------------------------------------------------------- helpers

async function operator(req: FastifyRequest, capability?: AdminCapability): Promise<AdminUser> {
  const admin = await readAdminSession(req)
  if (!admin) throw unauthorized('Operator sign-in required')
  if (capability) requireAdmin(admin.role, capability)
  return admin
}

/**
 * The console must always retain at least one enabled superadmin. Without
 * this, one careless change locks every operator out of their own platform
 * with no recovery short of editing the database by hand.
 */
async function assertNotLastSuperadmin(
  target: AdminUser,
  change: { losingRole?: boolean; beingDisabled?: boolean; beingDeleted?: boolean },
): Promise<void> {
  if (target.role !== 'SUPERADMIN' || target.disabledAt !== null) return
  if (!change.losingRole && !change.beingDisabled && !change.beingDeleted) return

  const remaining = await prisma.adminUser.count({
    where: { role: 'SUPERADMIN', disabledAt: null, id: { not: target.id } },
  })
  if (remaining === 0) {
    throw conflict(
      'last_superadmin',
      'This is the only active superadmin. Promote another operator before changing this one.',
    )
  }
}

function serializeUser(u: {
  id: string
  email: string
  name: string | null
  emailVerified: boolean
  createdAt: Date
  memberships: Array<{ id: string; role: string; tenant: { id: string; name: string; slug: string; status: string } }>
  _count: { sessions: number }
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    email_verified: u.emailVerified,
    created_at: u.createdAt,
    active_sessions: u._count.sessions,
    memberships: u.memberships.map((m) => ({
      id: m.id,
      role: m.role,
      tenant: m.tenant,
    })),
  }
}
