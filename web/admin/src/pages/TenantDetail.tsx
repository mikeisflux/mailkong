import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, ApiError, type Operator } from '../api'
import { Banner, Button, Card, Check, Empty, Field, Spinner, Status, relative } from '../ui'

interface Detail {
  tenant: {
    id: string; name: string; slug: string; status: string; statusReason: string | null
    dailyCap: number; notes: string | null; tags: string[]
    postalOrgId: string | null; stripeCustomerId: string | null; createdAt: string
    plan: { key: string; name: string } | null
    subscription: { sendsUsed: number; periodEnd: string } | null
    domains: Array<{ id: string; name: string; spfOk: boolean; dkimOk: boolean; dmarcOk: boolean; verifiedAt: string | null }>
    servers: Array<{ id: string; name: string; ipPool: { name: string } | null }>
    webhooks: Array<{ id: string; url: string; consecutiveFailures: number; lastStatus: number | null }>
    memberships: Array<{ id: string; role: string; user: { email: string; name: string | null } }>
    usageDays: Array<{ day: string; sent: number; bounced: number }>
  }
  recent_messages: Array<{ id: string; to: string; subject: string | null; status: string; createdAt: string }>
}

export default function TenantDetail({ me }: { me: Operator }) {
  const { id = '' } = useParams()
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [cap, setCap] = useState('')

  const load = useCallback(() => api.get<Detail>(`/tenants/${id}`).then(setData), [id])
  useEffect(() => { void load() }, [load])

  const can = (c: string) =>
    me.role === 'SUPERADMIN' || (me.role === 'SUPPORT' && ['tenant:pause', 'tenant:impersonate'].includes(c))

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed')
    }
  }

  if (!data) return <Spinner />
  const t = data.tenant

  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <h1>{t.name}</h1>
        <Status value={t.status} />
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t.slug} · created {new Date(t.createdAt).toLocaleDateString()}
        {t.postalOrgId && <> · Postal org <code>{t.postalOrgId}</code></>}
        {t.stripeCustomerId && <> · Stripe <code>{t.stripeCustomerId}</code></>}
      </p>

      {error && <Banner level="error">{error}</Banner>}
      {t.statusReason && <Banner level="warning"><strong>Status reason:</strong> {t.statusReason}</Banner>}

      <Card title="Actions">
        <div className="row" style={{ marginBottom: 14 }}>
          {t.status === 'PAUSED' || t.status === 'DISABLED' ? (
            <Button variant="primary" disabled={!can('tenant:pause')} onClick={() => act(() => api.post(`/tenants/${id}/resume`))}>
              Resume sending
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={!can('tenant:pause')}
              onClick={() => {
                if (!reason.trim()) return setError('Give a reason before pausing — it is shown to the customer and written to the audit log.')
                void act(() => api.post(`/tenants/${id}/pause`, { reason }))
              }}
            >
              Pause sending
            </Button>
          )}

          <Button
            variant="danger"
            disabled={!can('tenant:pause')}
            onClick={() => {
              if (!reason.trim()) return setError('Give a reason before disabling.')
              if (!confirm('Disable revokes every credential and ends all sessions. Continue?')) return
              void act(() => api.post(`/tenants/${id}/disable`, { reason }))
            }}
          >
            Disable account
          </Button>

          <Button
            disabled={!can('tenant:impersonate')}
            onClick={() =>
              act(async () => {
                const r = await api.post<{ app_url: string; as: string }>(`/tenants/${id}/impersonate`)
                alert(`Session opened as ${r.as}. Open ${r.app_url} in this browser — the dashboard will show a "viewing as" banner.`)
              })
            }
          >
            Impersonate owner
          </Button>
        </div>

        <Field label="Reason" hint="Shown to the customer when sending is refused, and recorded in the audit log.">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. bounce rate above threshold pending review" />
        </Field>

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Daily cap">
            <input
              type="number"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder={String(t.dailyCap)}
              style={{ maxWidth: 180 }}
            />
          </Field>
          <Button
            style={{ marginBottom: 14 }}
            disabled={!cap}
            onClick={() => act(() => api.patch(`/tenants/${id}`, { daily_cap: Number(cap) }).then(() => setCap('')))}
          >
            Update cap
          </Button>
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="Usage">
          <table>
            <tbody>
              <tr><td>Plan</td><td>{t.plan?.name ?? '—'}</td></tr>
              <tr><td>Sends this cycle</td><td className="num">{t.subscription?.sendsUsed.toLocaleString() ?? '—'}</td></tr>
              <tr><td>Cycle ends</td><td>{t.subscription ? new Date(t.subscription.periodEnd).toLocaleDateString() : '—'}</td></tr>
              <tr><td>Daily cap</td><td className="num">{t.dailyCap.toLocaleString()}</td></tr>
            </tbody>
          </table>
        </Card>

        <Card title="Servers and pools">
          {t.servers.length === 0 ? <Empty title="No servers" /> : (
            <table>
              <tbody>
                {t.servers.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{s.ipPool?.name ?? <span className="muted">default pool</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Domains">
        {t.domains.length === 0 ? <Empty title="No domains" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Domain</th><th>Checks</th><th>Verified</th></tr></thead>
              <tbody>
                {t.domains.map((d) => (
                  <tr key={d.id}>
                    <td style={{ color: 'var(--ink)', fontWeight: 550 }}>{d.name}</td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <Check ok={d.spfOk} label="SPF" />
                        <Check ok={d.dkimOk} label="DKIM" />
                        <Check ok={d.dmarcOk} label="DMARC" />
                      </span>
                    </td>
                    <td className="muted">{d.verifiedAt ? new Date(d.verifiedAt).toLocaleDateString() : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Team">
        <table>
          <tbody>
            {t.memberships.map((m) => (
              <tr key={m.id}>
                <td className="mono">{m.user.email}</td>
                <td>{m.role.toLowerCase().replace('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Recent messages">
        {data.recent_messages.length === 0 ? <Empty title="No messages" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
              <tbody>
                {data.recent_messages.map((m) => (
                  <tr key={m.id}>
                    <td className="muted">{relative(m.createdAt)}</td>
                    <td className="mono">{m.to}</td>
                    <td>{m.subject ?? <span className="muted">(none)</span>}</td>
                    <td><Status value={m.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
