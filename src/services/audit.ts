import { prisma } from '../db.js'

/**
 * Append-only. Spec 9.2: "Immutable. You will need this."
 * Nothing in the codebase updates or deletes these rows.
 */
export async function audit(input: {
  action: string
  actorType?: 'admin' | 'user' | 'system'
  adminId?: string | null
  actorId?: string | null
  tenantId?: string | null
  payload?: unknown
  ip?: string | null
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      action: input.action,
      actorType: input.actorType ?? 'admin',
      adminId: input.adminId ?? null,
      actorId: input.actorId ?? null,
      tenantId: input.tenantId ?? null,
      payload: (input.payload ?? null) as never,
      ip: input.ip ?? null,
    },
  })
}
