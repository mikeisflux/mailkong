import type { AdminRole, MemberRole } from '@prisma/client'
import { forbidden } from '../lib/errors.js'

/** Customer roles, spec 8.3. */
export type Capability =
  | 'send'
  | 'credentials'
  | 'domains:write'
  | 'domains:read'
  | 'billing'
  | 'team'
  | 'activity'
  | 'settings'

const MEMBER_CAPABILITIES: Record<MemberRole, Capability[]> = {
  OWNER: ['send', 'credentials', 'domains:write', 'domains:read', 'billing', 'team', 'activity', 'settings'],
  ADMIN: ['send', 'credentials', 'domains:write', 'domains:read', 'team', 'activity', 'settings'],
  DEVELOPER: ['send', 'credentials', 'domains:write', 'domains:read', 'activity'],
  READ_ONLY: ['domains:read', 'activity'],
}

export const memberCan = (role: MemberRole, cap: Capability): boolean =>
  MEMBER_CAPABILITIES[role].includes(cap)

export function requireMember(role: MemberRole, cap: Capability): void {
  if (!memberCan(role, cap)) {
    throw forbidden('insufficient_role', `Your role (${role.toLowerCase()}) cannot perform this action`)
  }
}

/** Admin roles, spec 9.3. */
export type AdminCapability =
  | 'tenant:pause'
  | 'tenant:impersonate'
  | 'pool:write'
  | 'plans:write'
  | 'refunds'
  | 'messages:read'
  | 'abuse:write'
  | 'system:write'

const ADMIN_CAPABILITIES: Record<AdminRole, AdminCapability[]> = {
  SUPERADMIN: [
    'tenant:pause',
    'tenant:impersonate',
    'pool:write',
    'plans:write',
    'refunds',
    'messages:read',
    'abuse:write',
    'system:write',
  ],
  SUPPORT: ['tenant:pause', 'tenant:impersonate', 'messages:read', 'abuse:write'],
  BILLING: ['plans:write', 'refunds'],
  READ_ONLY: ['messages:read'],
}

export const adminCan = (role: AdminRole, cap: AdminCapability): boolean =>
  ADMIN_CAPABILITIES[role].includes(cap)

export function requireAdmin(role: AdminRole, cap: AdminCapability): void {
  if (!adminCan(role, cap)) {
    throw forbidden('insufficient_role', `Admin role ${role.toLowerCase()} cannot perform this action`)
  }
}
