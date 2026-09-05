import { prisma } from '../db.js'
import { config } from '../config.js'
import { postalAdmin } from '../postal/index.js'
import { generateApiKey, generateSmtpPassword, hashSecret } from '../lib/crypto.js'
import { badRequest, notFound } from '../lib/errors.js'
import { audit } from './audit.js'

/**
 * Secrets are returned exactly once, at creation, and only the Argon2 hash is
 * kept. There is deliberately no code path that can re-read a secret.
 */
export interface CreatedCredential {
  id: string
  kind: 'API_KEY' | 'SMTP'
  name: string
  prefix: string
  /** Shown once. Never retrievable again. */
  secret: string
  smtp?: { host: string; port: number; username: string; security: 'STARTTLS' }
}

export async function createCredential(input: {
  tenantId: string
  kind: 'API_KEY' | 'SMTP'
  name: string
  actorId?: string
}): Promise<CreatedCredential> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: input.tenantId },
    include: { servers: true },
  })
  const server = tenant.servers[0]
  if (!server?.postalPermalink) throw badRequest('no_server', 'This account has no mail server yet')

  if (input.kind === 'API_KEY') {
    const { key, prefix } = generateApiKey()

    // Postal holds its own credential so SMTP and API share one identity
    // and one hold switch when the tenant is paused.
    const postal = await postalAdmin.createCredential(server.postalPermalink, {
      type: 'API',
      name: input.name,
    })

    const credential = await prisma.credential.create({
      data: {
        tenantId: input.tenantId,
        serverId: server.id,
        kind: 'API_KEY',
        name: input.name,
        prefix,
        secretHash: await hashSecret(key),
        postalCredentialId: String(postal.id),
      },
    })

    await audit({
      action: 'credential.created',
      actorType: 'user',
      actorId: input.actorId ?? null,
      tenantId: input.tenantId,
      payload: { kind: 'API_KEY', name: input.name, prefix },
    })

    return { id: credential.id, kind: 'API_KEY', name: input.name, prefix, secret: key }
  }

  const password = generateSmtpPassword()
  const username = `${tenant.slug}/${slugifyName(input.name)}`
  const postal = await postalAdmin.createCredential(server.postalPermalink, {
    type: 'SMTP',
    name: input.name,
    key: password,
  })

  const credential = await prisma.credential.create({
    data: {
      tenantId: input.tenantId,
      serverId: server.id,
      kind: 'SMTP',
      name: input.name,
      prefix: username,
      secretHash: await hashSecret(password),
      postalCredentialId: String(postal.id),
    },
  })

  await audit({
    action: 'credential.created',
    actorType: 'user',
    actorId: input.actorId ?? null,
    tenantId: input.tenantId,
    payload: { kind: 'SMTP', name: input.name },
  })

  return {
    id: credential.id,
    kind: 'SMTP',
    name: input.name,
    prefix: username,
    secret: password,
    smtp: {
      host: config.POSTAL_SMTP_HOST,
      port: config.POSTAL_SMTP_PORT,
      username,
      security: 'STARTTLS',
    },
  }
}

export async function revokeCredential(id: string, tenantId: string, actorId?: string): Promise<void> {
  const credential = await prisma.credential.findFirst({
    where: { id, tenantId },
    include: { tenant: { include: { servers: true } } },
  })
  if (!credential) throw notFound('Credential')

  const server = credential.tenant.servers[0]
  if (server?.postalPermalink && credential.postalCredentialId) {
    await postalAdmin
      .deleteCredential(server.postalPermalink, Number(credential.postalCredentialId))
      .catch(() => undefined)
  }

  await prisma.credential.update({ where: { id }, data: { revokedAt: new Date() } })
  await audit({
    action: 'credential.revoked',
    actorType: 'user',
    actorId: actorId ?? null,
    tenantId,
    payload: { credentialId: id, name: credential.name },
  })
}

const slugifyName = (n: string) =>
  n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'smtp'
