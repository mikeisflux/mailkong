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
  // Reading customer accounts is a support function; changing or deleting
  // them is not.
  | 'users:read'
  | 'users:write'
  | 'users:delete'
  // Managing other operators is superadmin-only: anything less would let an
  // account escalate itself by minting a more privileged one.
  | 'operators:read'
  | 'operators:write'

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
    'users:read',
    'users:write',
    'users:delete',
    'operators:read',
    'operators:write',
  ],
  SUPPORT: [
    'tenant:pause',
    'tenant:impersonate',
    'messages:read',
    'abuse:write',
    'users:read',
    // Support can unblock a customer -- reset a password, revoke sessions --
    // but cannot delete an account or touch operator accounts.
    'users:write',
  ],
  BILLING: ['plans:write', 'refunds', 'users:read'],
  READ_ONLY: ['messages:read', 'users:read'],
}

export const adminCan = (role: AdminRole, cap: AdminCapability): boolean =>
  ADMIN_CAPABILITIES[role].includes(cap)

export function requireAdmin(role: AdminRole, cap: AdminCapability): void {
  if (!adminCan(role, cap)) {
    throw forbidden('insufficient_role', `Admin role ${role.toLowerCase()} cannot perform this action`)
  }
}
