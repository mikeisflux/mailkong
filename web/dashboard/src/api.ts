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
  const res = await fetch(`/_app${path}`, {
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
  del: <T>(path: string) => request<T>('DELETE', path),
}

// ------------------------------------------------------------------ types

export interface Me {
  user: { id: string; email: string; name: string | null }
  impersonated: boolean
  tenants: Array<{
    id: string
    name: string
    slug: string
    role: string
    status: string
    status_reason: string | null
    plan: string | null
  }>
}

export interface DnsRecord {
  type: string
  name: string
  value: string
  priority?: number
  purpose: string
  required: boolean
}

export interface Domain {
  id: string
  name: string
  kind: string
  spfOk: boolean
  dkimOk: boolean
  dmarcOk: boolean
  returnPathOk: boolean
  verifiedAt: string | null
  lastCheckedAt: string | null
  lastCheckOutput: string | null
  dnsRecords: DnsRecord[] | null
}

export interface Credential {
  id: string
  kind: 'API_KEY' | 'SMTP'
  name: string
  prefix: string
  lastUsedAt: string | null
  createdAt: string
}

export interface Message {
  id: string
  to: string
  from: string
  subject: string | null
  status: string
  tag: string | null
  bounceReason: string | null
  deliveredAt: string | null
  createdAt: string
}

export interface Overview {
  quota: { dailyUsed: number; dailyCap: number; cycleUsed: number; cycleCap: number; cycleEnd: string | null }
  last24h: { total: number; bounced: number; bounce_rate: number; by_status: Record<string, number> }
  domains: Array<{ id: string; name: string; verified: boolean; spf: boolean; dkim: boolean; dmarc: boolean }>
  recent: Array<{ id: string; to: string; subject: string | null; status: string; created_at: string }>
  alerts: Array<{ level: 'warning' | 'error'; message: string }>
}

export interface WebhookEndpoint {
  id: string
  url: string
  events: string[]
  enabled: boolean
  lastStatus: number | null
  consecutiveFailures: number
  deliveries?: Array<{ id: string; event: string; statusCode: number | null; latencyMs: number | null; createdAt: string }>
}
