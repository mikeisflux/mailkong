import type { FastifyRequest } from 'fastify'
import type { Tenant } from '@prisma/client'
import { authenticateApiKey } from '../auth/apiKey.js'

declare module 'fastify' {
  interface FastifyRequest {
    apiTenant?: Tenant
    apiCredentialId?: string
  }
}

/** Attaches the authenticated tenant. Used as a preHandler on /v1/*. */
export async function requireApiKey(req: FastifyRequest): Promise<void> {
  const ctx = await authenticateApiKey(req.headers.authorization)
  req.apiTenant = ctx.tenant
  req.apiCredentialId = ctx.credentialId
}

export function tenantOf(req: FastifyRequest): Tenant {
  if (!req.apiTenant) throw new Error('requireApiKey did not run for this route')
  return req.apiTenant
}

/** Cursor pagination over created_at descending. */
export interface Page<T> {
  data: T[]
  has_more: boolean
  next_cursor: string | null
}

export function paginate<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  return {
    data,
    has_more: hasMore,
    next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
  }
}
