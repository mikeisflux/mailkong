import '@fastify/cookie'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../db.js'
import { randomToken, sha256 } from '../lib/crypto.js'
import { config } from '../config.js'
import { unauthorized } from '../lib/errors.js'

const SESSION_COOKIE = 'mk_session'
const ADMIN_COOKIE = 'mk_admin'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14

export interface SessionUser {
  userId: string
  sessionId: string
  impersonatorAdminId: string | null
}

export async function createSession(
  reply: FastifyReply,
  userId: string,
  opts: { ip?: string; userAgent?: string; impersonatorAdminId?: string } = {},
): Promise<string> {
  const token = randomToken()
  await prisma.session.create({
    data: {
      id: sha256(token),
      userId,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      impersonatorAdminId: opts.impersonatorAdminId ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })
  reply.setCookie(SESSION_COOKIE, token, cookieOptions())
  return token
}

export async function readSession(req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[SESSION_COOKIE]
  if (!token) return null
  const session = await prisma.session.findUnique({ where: { id: sha256(token) } })
  if (!session || session.expiresAt < new Date()) return null
  return {
    userId: session.userId,
    sessionId: session.id,
    impersonatorAdminId: session.impersonatorAdminId,
  }
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE]
  if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } })
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

// -- admin sessions ------------------------------------------------------
// Separate cookie AND separate table, so an admin session can never resolve
// to a customer account through a lookup mistake.

const ADMIN_TTL_MS = 1000 * 60 * 60 * 12

export async function createAdminSession(
  reply: FastifyReply,
  adminId: string,
  opts: { ip?: string; userAgent?: string } = {},
): Promise<void> {
  const token = randomToken()
  await prisma.adminSession.create({
    data: {
      id: sha256(token),
      adminId,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      expiresAt: new Date(Date.now() + ADMIN_TTL_MS),
    },
  })
  reply.setCookie(ADMIN_COOKIE, token, { ...cookieOptions(), maxAge: ADMIN_TTL_MS / 1000 })
}

export async function readAdminSession(req: FastifyRequest) {
  const token = req.cookies[ADMIN_COOKIE]
  if (!token) return null
  const session = await prisma.adminSession.findUnique({
    where: { id: sha256(token) },
    include: { admin: true },
  })
  if (!session || session.expiresAt < new Date()) return null
  if (session.admin.disabledAt) return null
  return session.admin
}

export async function destroyAdminSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[ADMIN_COOKIE]
  if (token) await prisma.adminSession.deleteMany({ where: { id: sha256(token) } })
  reply.clearCookie(ADMIN_COOKIE, { path: '/' })
}

export function requireSession(user: SessionUser | null): SessionUser {
  if (!user) throw unauthorized('Sign in to continue')
  return user
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    signed: false,
  }
}

/** Removes expired rows. Run from the maintenance job, not on every request. */
export async function pruneSessions(): Promise<number> {
  const now = new Date()
  const [a, b] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.adminSession.deleteMany({ where: { expiresAt: { lt: now } } }),
  ])
  return a.count + b.count
}
