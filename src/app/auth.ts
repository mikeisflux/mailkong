import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { hashSecret, randomToken, sha256, verifySecret } from '../lib/crypto.js'
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js'
import { createSession, destroySession } from '../auth/session.js'
import { provisionTenant } from '../services/provisioning.js'
import { sendPlatformMail } from '../mail/mailer.js'
import { templates } from '../mail/templates.js'
import { audit } from '../services/audit.js'
import { logger } from '../lib/logger.js'
import { assertPasswordLoginAllowed } from './sso.js'

/**
 * Every flow that mints or consumes a single-use token.
 *
 * Two rules hold throughout:
 *
 *   Tokens are stored as SHA-256 digests, never plaintext, so a database
 *   read cannot be replayed as a login.
 *
 *   Endpoints that take an email address answer identically whether or not
 *   the account exists. Otherwise the reset form becomes an oracle for
 *   enumerating customers.
 */

const TTL = {
  verify: 24 * 3600_000,
  magic: 15 * 60_000,
  reset: 3600_000,
  invite: 7 * 86_400_000,
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------ email verification

  app.post('/auth/signup', async (req, reply) => {
    const flag = await prisma.featureFlag.findUnique({ where: { key: 'signup_open' } })
    if (!(flag?.enabled ?? config.SIGNUP_OPEN)) {
      throw forbidden('signup_closed', 'Signups are currently invite-only')
    }

    const body = z.object({
      email: z.string().email(),
      password: z.string().min(12, 'Use at least 12 characters'),
      name: z.string().min(1).max(80),
      organization: z.string().min(1).max(80),
    }).parse(req.body)

    const email = body.email.toLowerCase()
    if (await prisma.user.findUnique({ where: { email } })) {
      throw conflict('email_taken', 'An account with that email already exists')
    }

    const user = await prisma.user.create({
      data: { email, name: body.name, passwordHash: await hashSecret(body.password) },
    })

    const { tenantId } = await provisionTenant({
      name: body.organization,
      ownerUserId: user.id,
      ownerEmail: user.email,
    })

    await issueToken(user.id, 'verify_email', TTL.verify, (token) =>
      sendPlatformMail({
        to: user.email,
        ...templates.verifyEmail({ name: user.name, url: `${config.APP_URL}/verify/${token}` }),
      }),
    )

    await createSession(reply, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
    reply.code(201)
    return { user: { id: user.id, email: user.email, name: user.name }, tenantId }
  })

  app.post<{ Params: { token: string } }>('/auth/verify/:token', async (req) => {
    const record = await consumeToken(req.params.token, 'verify_email')
    if (!record) throw badRequest('invalid_token', 'That confirmation link is invalid or has expired')
    await prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } })
    return { ok: true }
  })

  app.post('/auth/resend-verification', async (req) => {
    const body = z.object({ email: z.string().email() }).parse(req.body)
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })

    if (user && !user.emailVerified) {
      await issueToken(user.id, 'verify_email', TTL.verify, (token) =>
        sendPlatformMail({
          to: user.email,
          ...templates.verifyEmail({ name: user.name, url: `${config.APP_URL}/verify/${token}` }),
        }),
      )
    }
    return { ok: true }
  })

  // --------------------------------------------------------------- password

  app.post('/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body)

    // Checked before the credential, so an organization that requires SSO
    // gets a clear answer rather than a password prompt that always fails.
    await assertPasswordLoginAllowed(body.email.toLowerCase())

    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })

    // Verify against a dummy hash when the account is absent, so a missing
    // account and a wrong password take the same time.
    const ok = user?.passwordHash
      ? await verifySecret(user.passwordHash, body.password)
      : await verifySecret(DUMMY_HASH, body.password)
    if (!user || !ok) throw unauthorized('Incorrect email or password')

    await createSession(reply, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
    return { user: { id: user.id, email: user.email, name: user.name } }
  })

  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req, reply)
    return { ok: true }
  })

  app.post('/auth/forgot-password', async (req) => {
    const body = z.object({ email: z.string().email() }).parse(req.body)
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })

    if (user) {
      await issueToken(user.id, 'password_reset', TTL.reset, (token) =>
        sendPlatformMail({
          to: user.email,
          ...templates.passwordReset({ url: `${config.APP_URL}/reset/${token}` }),
        }),
      )
    }

    // Same answer either way: this endpoint must not reveal who has an account.
    return { ok: true, message: 'If that address has an account, a reset link is on its way.' }
  })

  app.post<{ Params: { token: string } }>('/auth/reset-password/:token', async (req, reply) => {
    const body = z.object({ password: z.string().min(12) }).parse(req.body)
    const record = await consumeToken(req.params.token, 'password_reset')
    if (!record) throw badRequest('invalid_token', 'That reset link is invalid or has expired')

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await hashSecret(body.password) },
      }),
      // Anyone who had a session on this account loses it. A reset is often
      // a response to compromise.
      prisma.session.deleteMany({ where: { userId: record.userId } }),
    ])

    await audit({ action: 'user.password_reset', actorType: 'user', actorId: record.userId, ip: req.ip })
    await createSession(reply, record.userId, { ip: req.ip, userAgent: req.headers['user-agent'] })
    return { ok: true }
  })

  // ------------------------------------------------------------- magic link

  app.post('/auth/magic-link', async (req) => {
    const body = z.object({ email: z.string().email() }).parse(req.body)
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })

    if (user) {
      await issueToken(user.id, 'magic_link', TTL.magic, (token) =>
        sendPlatformMail({
          to: user.email,
          ...templates.magicLink({ url: `${config.APP_URL}/magic/${token}` }),
        }),
      )
    }
    return { ok: true, message: 'If that address has an account, a sign-in link is on its way.' }
  })

  app.post<{ Params: { token: string } }>('/auth/magic-link/:token', async (req, reply) => {
    const record = await consumeToken(req.params.token, 'magic_link')
    if (!record) throw badRequest('invalid_token', 'That sign-in link is invalid or has already been used')

    // Following a link from an inbox proves control of the address.
    await prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } })
    await createSession(reply, record.userId, { ip: req.ip, userAgent: req.headers['user-agent'] })
    return { ok: true }
  })

  // ---------------------------------------------------------------- invites

  app.get<{ Params: { token: string } }>('/auth/invite/:token', async (req) => {
    const invite = await prisma.invite.findUnique({
      where: { tokenHash: sha256(req.params.token) },
      include: { tenant: { select: { name: true } } },
    })
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw badRequest('invalid_invite', 'That invitation is invalid or has expired')
    }

    const existing = await prisma.user.findUnique({ where: { email: invite.email } })
    return {
      email: invite.email,
      organization: invite.tenant.name,
      role: invite.role,
      // Tells the UI whether to ask for a password or just a confirmation.
      has_account: existing !== null,
    }
  })

  app.post<{ Params: { token: string } }>('/auth/invite/:token', async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(80).optional(),
      password: z.string().min(12).optional(),
    }).parse(req.body ?? {})

    const invite = await prisma.invite.findUnique({ where: { tokenHash: sha256(req.params.token) } })
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw badRequest('invalid_invite', 'That invitation is invalid or has expired')
    }

    let user = await prisma.user.findUnique({ where: { email: invite.email } })
    if (!user) {
      if (!body.password) {
        throw badRequest('password_required', 'Choose a password to create your account')
      }
      user = await prisma.user.create({
        data: {
          email: invite.email,
          name: body.name ?? null,
          passwordHash: await hashSecret(body.password),
          // The invitation arrived at this address, so it is already proven.
          emailVerified: true,
        },
      })
    }

    await prisma.$transaction([
      prisma.membership.upsert({
        where: { userId_tenantId: { userId: user.id, tenantId: invite.tenantId } },
        create: { userId: user.id, tenantId: invite.tenantId, role: invite.role },
        update: { role: invite.role },
      }),
      prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
    ])

    await audit({
      action: 'team.invite_accepted',
      actorType: 'user',
      actorId: user.id,
      tenantId: invite.tenantId,
      payload: { email: invite.email, role: invite.role },
      ip: req.ip,
    })

    await createSession(reply, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
    return { ok: true, tenantId: invite.tenantId }
  })
}

// ---------------------------------------------------------------- helpers

const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000'

/**
 * Mints a single-use token, hands the plaintext to `deliver`, and stores only
 * its digest. Any earlier unused token of the same purpose is invalidated, so
 * requesting a new reset link retires the old one.
 */
async function issueToken(
  userId: string,
  purpose: string,
  ttlMs: number,
  deliver: (token: string) => Promise<unknown>,
): Promise<void> {
  const token = randomToken()

  await prisma.loginToken.deleteMany({ where: { userId, purpose, usedAt: null } })
  await prisma.loginToken.create({
    data: {
      userId,
      purpose,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  })

  try {
    await deliver(token)
  } catch (err) {
    logger.error({ err, userId, purpose }, 'failed to deliver auth token')
  }
}

/** Returns the token row and marks it used, or null if it cannot be redeemed. */
async function consumeToken(token: string, purpose: string) {
  const record = await prisma.loginToken.findUnique({ where: { tokenHash: sha256(token) } })
  if (!record || record.purpose !== purpose) return null
  if (record.usedAt || record.expiresAt < new Date()) return null

  // Conditional update: two simultaneous redemptions cannot both win.
  const { count } = await prisma.loginToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  })
  return count === 1 ? record : null
}
