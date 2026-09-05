import type { FastifyInstance } from 'fastify'
import { createPublicKey, createVerify } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js'
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js'
import { createSession, readSession } from '../auth/session.js'
import { requireMember } from '../auth/rbac.js'
import { audit } from '../services/audit.js'
import { logger } from '../lib/logger.js'

/**
 * OIDC single sign-on for customer teams (phase 4).
 *
 * OIDC rather than SAML: every provider a customer is likely to run speaks
 * it, and it avoids XML signature canonicalisation, which is where SAML
 * implementations get their vulnerabilities.
 *
 * The security of this rests on four checks, all of which are enforced below
 * and none of which are optional:
 *
 *   1. `state` is single use and bound to one connection, so a callback
 *      cannot be replayed or aimed at a different tenant.
 *   2. `nonce` from the request must appear in the returned id_token, which
 *      is what stops a token minted for another application being accepted.
 *   3. The id_token signature is verified against the provider's published
 *      JWKS, and `iss` and `aud` must match what we configured.
 *   4. `email_verified` must be true AND the domain must be one this
 *      connection is allowed to claim. Without the domain check, any customer
 *      could configure a provider that asserts anybody's address.
 */
export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------- configuration

  app.get('/t/:tenantId/sso', async (req) => {
    const ctx = await ownerish(req)
    const sso = await prisma.ssoConnection.findUnique({ where: { tenantId: ctx.tenantId } })
    return {
      configured: sso !== null,
      connection: sso
        ? {
            issuer: sso.issuer,
            client_id: sso.clientId,
            domains: sso.domains,
            enforced: sso.enforced,
            enabled: sso.enabled,
            default_role: sso.defaultRole,
            discovered_at: sso.discoveredAt,
          }
        : null,
      // The value the customer pastes into their provider.
      redirect_uri: `${config.APP_URL}/_app/sso/callback`,
      login_url: `${config.APP_URL}/sso/${ctx.tenantId}`,
    }
  })

  app.put('/t/:tenantId/sso', async (req) => {
    const ctx = await ownerish(req)
    const body = z.object({
      issuer: z.string().url(),
      client_id: z.string().min(1),
      client_secret: z.string().min(1).optional(),
      domains: z.array(z.string().min(3)).min(1).max(10),
      enforced: z.boolean().default(false),
      enabled: z.boolean().default(true),
      default_role: z.enum(['ADMIN', 'DEVELOPER', 'READ_ONLY']).default('READ_ONLY'),
    }).parse(req.body)

    const existing = await prisma.ssoConnection.findUnique({ where: { tenantId: ctx.tenantId } })
    if (!existing && !body.client_secret) {
      throw badRequest('client_secret_required', 'A client secret is required to create a connection')
    }

    const discovered = await discover(body.issuer)

    const domains = body.domains.map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    // The platform's own domain would let a customer's provider vend accounts
    // that look like ours.
    if (domains.some((d) => d === config.PLATFORM_DOMAIN || d.endsWith(`.${config.PLATFORM_DOMAIN}`))) {
      throw badRequest('reserved_domain', 'That email domain is reserved by the platform')
    }

    const data = {
      issuer: body.issuer.replace(/\/$/, ''),
      clientId: body.client_id,
      domains,
      enforced: body.enforced,
      enabled: body.enabled,
      defaultRole: body.default_role,
      authEndpoint: discovered.authorization_endpoint,
      tokenEndpoint: discovered.token_endpoint,
      jwksUri: discovered.jwks_uri,
      discoveredAt: new Date(),
      ...(body.client_secret ? { clientSecret: encrypt(body.client_secret) } : {}),
    }

    const saved = await prisma.ssoConnection.upsert({
      where: { tenantId: ctx.tenantId },
      create: { tenantId: ctx.tenantId, clientSecret: encrypt(body.client_secret!), ...data },
      update: data,
    })

    await audit({
      action: 'sso.configured',
      actorType: 'user',
      actorId: ctx.userId,
      tenantId: ctx.tenantId,
      payload: { issuer: saved.issuer, domains, enforced: saved.enforced },
      ip: req.ip,
    })
    return { ok: true }
  })

  app.delete('/t/:tenantId/sso', async (req, reply) => {
    const ctx = await ownerish(req)
    await prisma.ssoConnection.deleteMany({ where: { tenantId: ctx.tenantId } })
    await audit({
      action: 'sso.removed',
      actorType: 'user',
      actorId: ctx.userId,
      tenantId: ctx.tenantId,
      ip: req.ip,
    })
    reply.code(204)
  })

  // ------------------------------------------------------------- sign-in

  app.get<{ Params: { tenantId: string } }>('/sso/:tenantId/start', async (req, reply) => {
    const sso = await prisma.ssoConnection.findUnique({ where: { tenantId: req.params.tenantId } })
    if (!sso || !sso.enabled) throw notFound('SSO configuration')
    if (!sso.authEndpoint) throw badRequest('sso_not_discovered', 'This connection is not fully configured')

    const state = randomToken()
    const nonce = randomToken()

    await prisma.ssoState.create({
      data: {
        id: sha256(state),
        connectionId: sso.id,
        nonce: sha256(nonce),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    })

    const url = new URL(sso.authEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', sso.clientId)
    url.searchParams.set('redirect_uri', `${config.APP_URL}/_app/sso/callback`)
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)

    reply.redirect(url.toString())
  })

  app.get('/sso/callback', async (req, reply) => {
    const q = z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }).parse(req.query)

    if (q.error) {
      logger.warn({ error: q.error, description: q.error_description }, 'sso provider returned an error')
      return reply.redirect(`${config.APP_URL}/sso-error?reason=provider`)
    }
    if (!q.code || !q.state) return reply.redirect(`${config.APP_URL}/sso-error?reason=malformed`)

    // Single use: consuming the state here means a replayed callback finds
    // nothing and fails closed.
    const stateRow = await prisma.ssoState.findUnique({ where: { id: sha256(q.state) } })
    if (!stateRow || stateRow.expiresAt < new Date()) {
      return reply.redirect(`${config.APP_URL}/sso-error?reason=expired`)
    }
    await prisma.ssoState.delete({ where: { id: stateRow.id } })

    const sso = await prisma.ssoConnection.findUnique({ where: { id: stateRow.connectionId } })
    if (!sso || !sso.enabled || !sso.tokenEndpoint || !sso.jwksUri) {
      return reply.redirect(`${config.APP_URL}/sso-error?reason=misconfigured`)
    }

    let claims: IdTokenClaims
    try {
      const idToken = await exchangeCode(sso, q.code)
      claims = await verifyIdToken(idToken, sso)
    } catch (err) {
      logger.warn({ err, tenantId: sso.tenantId }, 'sso token exchange or verification failed')
      return reply.redirect(`${config.APP_URL}/sso-error?reason=verification`)
    }

    if (claims.nonce === undefined || sha256(claims.nonce) !== stateRow.nonce) {
      logger.warn({ tenantId: sso.tenantId }, 'sso nonce mismatch')
      return reply.redirect(`${config.APP_URL}/sso-error?reason=verification`)
    }

    const email = claims.email?.toLowerCase()
    if (!email || claims.email_verified !== true) {
      return reply.redirect(`${config.APP_URL}/sso-error?reason=unverified_email`)
    }

    // The check that makes domain binding meaningful: a customer's provider
    // may only assert addresses in domains they registered on the connection.
    const domain = email.slice(email.lastIndexOf('@') + 1)
    if (!sso.domains.includes(domain)) {
      logger.warn({ tenantId: sso.tenantId, domain }, 'sso asserted an unclaimed email domain')
      return reply.redirect(`${config.APP_URL}/sso-error?reason=domain`)
    }

    const user = await prisma.user.upsert({
      where: { email },
      create: { email, name: claims.name ?? null, emailVerified: true },
      update: { emailVerified: true, ...(claims.name ? { name: claims.name } : {}) },
    })

    // Just-in-time membership. Existing members keep the role they already
    // have -- SSO must not silently demote an owner to the default.
    await prisma.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId: sso.tenantId } },
      create: { userId: user.id, tenantId: sso.tenantId, role: sso.defaultRole },
      update: {},
    })

    await createSession(reply, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] })
    await audit({
      action: 'sso.login',
      actorType: 'user',
      actorId: user.id,
      tenantId: sso.tenantId,
      payload: { email, issuer: sso.issuer },
      ip: req.ip,
    })

    reply.redirect(`${config.APP_URL}/t/${sso.tenantId}`)
  })

  /**
   * Lets the sign-in page discover that an address must use SSO, before
   * asking for a password it will refuse.
   */
  app.post('/sso/lookup', async (req) => {
    const body = z.object({ email: z.string().email() }).parse(req.body)
    const email = body.email.toLowerCase()
    const domain = email.slice(email.lastIndexOf('@') + 1)

    const sso = await prisma.ssoConnection.findFirst({
      where: { enabled: true, domains: { has: domain } },
    })
    // Deliberately reveals only that a domain uses SSO, which the customer's
    // own login page reveals anyway. It does not confirm the account exists.
    return sso
      ? { sso: true, enforced: sso.enforced, start_url: `${config.APP_URL}/_app/sso/${sso.tenantId}/start` }
      : { sso: false, enforced: false, start_url: null }
  })
}

/** Refuses a password login when the user's domain enforces SSO. */
export async function assertPasswordLoginAllowed(email: string): Promise<void> {
  const domain = email.slice(email.lastIndexOf('@') + 1)
  const sso = await prisma.ssoConnection.findFirst({
    where: { enabled: true, enforced: true, domains: { has: domain } },
  })
  if (sso) {
    throw forbidden(
      'sso_required',
      'Your organization requires single sign-on. Use the SSO button rather than a password.',
    )
  }
}

// ------------------------------------------------------------- internals

interface IdTokenClaims {
  iss: string
  aud: string | string[]
  exp: number
  iat: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
}

async function discover(issuer: string) {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) {
    throw badRequest('discovery_failed', `Could not read ${url} (HTTP ${res.status})`)
  }
  const doc = (await res.json()) as {
    authorization_endpoint?: string
    token_endpoint?: string
    jwks_uri?: string
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw badRequest('discovery_incomplete', 'That issuer did not advertise the endpoints we need')
  }
  return doc as Required<typeof doc>
}

async function exchangeCode(
  sso: { tokenEndpoint: string | null; clientId: string; clientSecret: string },
  code: string,
): Promise<string> {
  const res = await fetch(sso.tokenEndpoint!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.APP_URL}/_app/sso/callback`,
      client_id: sso.clientId,
      client_secret: decrypt(sso.clientSecret),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`token endpoint returned ${res.status}`)

  const body = (await res.json()) as { id_token?: string }
  if (!body.id_token) throw new Error('no id_token in the token response')
  return body.id_token
}

/**
 * Verifies an id_token against the provider's JWKS.
 *
 * Implemented directly rather than pulled from a library so the checks are
 * visible: an unverified id_token is just a base64 string anybody can write.
 */
async function verifyIdToken(
  token: string,
  sso: { jwksUri: string | null; issuer: string; clientId: string },
): Promise<IdTokenClaims> {
  const [headerB64, payloadB64, signatureB64] = token.split('.')
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error('malformed id_token')

  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) as { kid?: string; alg?: string }
  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as IdTokenClaims

  if (header.alg !== 'RS256') throw new Error(`unsupported id_token algorithm ${header.alg}`)

  const jwks = (await (
    await fetch(sso.jwksUri!, { signal: AbortSignal.timeout(10_000) })
  ).json()) as { keys: Array<Record<string, string>> }

  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? jwks.keys[0]
  if (!jwk) throw new Error('no signing key published')

  const key = createPublicKey({ key: jwk as never, format: 'jwk' })
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${headerB64}.${payloadB64}`)
  if (!verifier.verify(key, Buffer.from(signatureB64, 'base64url'))) {
    throw new Error('id_token signature did not verify')
  }

  const now = Math.floor(Date.now() / 1000)
  if (claims.exp <= now) throw new Error('id_token has expired')
  // 5 minutes of clock skew, no more: a wider window widens replay.
  if (claims.iat > now + 300) throw new Error('id_token was issued in the future')

  if (claims.iss.replace(/\/$/, '') !== sso.issuer.replace(/\/$/, '')) {
    throw new Error(`id_token issuer ${claims.iss} does not match the configured issuer`)
  }

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(sso.clientId)) {
    throw new Error('id_token was not issued for this client')
  }

  return claims
}

async function ownerish(req: Parameters<typeof readSession>[0]) {
  const session = await readSession(req)
  if (!session) throw unauthorized('Not signed in')

  const tenantId = (req.params as { tenantId?: string }).tenantId
  if (!tenantId) throw badRequest('missing_tenant', 'No organization in the request path')

  const membership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: session.userId, tenantId } },
  })
  if (!membership) throw forbidden('not_a_member', 'You do not have access to this organization')
  requireMember(membership.role, 'settings')

  return { userId: session.userId, tenantId }
}
