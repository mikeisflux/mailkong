/**
 * Thin fetch wrapper for the control plane.
 *
 * Errors from the API arrive as { error: { code, message, detail } }. That
 * shape is preserved on the thrown object so screens can branch on `code`
 * (for example, showing the upgrade prompt only on `plan_cap_reached`)
 * rather than string-matching the message.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/_admin${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })

  if (res.status === 204) return undefined as T

  const payload = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (payload as { error?: { code: string; message: string; detail?: unknown } })?.error
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? `Request failed (${res.status})`,
      err?.detail,
    )
  }
  return payload as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

// ------------------------------------------------------------------ types

export interface Operator {
  id: string
  email: string
  name: string | null
  role: 'SUPERADMIN' | 'SUPPORT' | 'BILLING' | 'READ_ONLY'
}

export interface Overview {
  sends: { last_hour: number; last_24h: number }
  health: { bounce_rate: number; held: number; postal_reachable: boolean }
  accounts: { past_due: number; paused: number; open_abuse: number }
  pools: Array<{ id: string; name: string; kind: string; addresses: number; servers: number; warming: number }>
}

export interface TenantRow {
  id: string
  name: string
  slug: string
  status: string
  status_reason: string | null
  plan: string | null
  sends_this_cycle: number
  daily_cap: number
  domains: number
  tags: string[]
  created_at: string
}

export interface AuditRow {
  id: string
  action: string
  createdAt: string
  ip: string | null
  payload: unknown
  admin: { id: string; email: string } | null
  tenant: { id: string; name: string; slug: string } | null
}

export interface AbuseRow {
  id: string
  source: string
  subject: string | null
  raw: string
  status: string
  createdAt: string
  tenant: { id: string; name: string; slug: string; status: string } | null
}

export interface PoolRow {
  id: string
  name: string
  kind: string
  tenant: { id: string; name: string } | null
  addresses: Array<{ id: string; address: string; ptr: string | null; warming: boolean; dailyCap: number | null }>
  servers: Array<{ id: string }>
}
