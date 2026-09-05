import { prisma } from '../db.js'
import { verifySecret } from '../lib/crypto.js'
import { unauthorized } from '../lib/errors.js'
import type { Tenant } from '@prisma/client'

export interface ApiContext {
  tenant: Tenant
  credentialId: string
}

/**
 * Authenticates `Authorization: Bearer pk_live_...`.
 *
 * The stored prefix narrows the lookup to the handful of rows that could
 * match before any Argon2 verification runs, so an invalid key costs one
 * indexed query rather than a hash against every credential in the table.
 */
export async function authenticateApiKey(header: string | undefined): Promise<ApiContext> {
  if (!header) throw unauthorized()

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const key = match?.[1]
  if (!key || !key.startsWith('pk_')) throw unauthorized()

  const prefix = key.slice(0, 16)
  const candidates = await prisma.credential.findMany({
    where: { prefix, kind: 'API_KEY', revokedAt: null },
    include: { tenant: true },
  })

  for (const candidate of candidates) {
    if (await verifySecret(candidate.secretHash, key)) {
      // Best-effort: a failed timestamp write must never fail the request.
      void prisma.credential
        .update({ where: { id: candidate.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {})
      return { tenant: candidate.tenant, credentialId: candidate.id }
    }
  }

  throw unauthorized()
}
