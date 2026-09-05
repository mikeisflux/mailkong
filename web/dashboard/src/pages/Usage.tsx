import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { Banner, Button, Card, Empty, Spinner } from '../ui'

interface BillingPayload {
  billing_configured: boolean
  plan: { key: string; name: string; monthlyPrice: number } | null
  subscription: { status: string; periodEnd: string } | null
  plans: Array<{ id: string; key: string; name: string; monthlyPrice: number; limits: Record<string, number | boolean> }>
  invoices: Array<{ id: string; number: string | null; amount: number; status: string; url: string | null; created: string }>
}

interface UsagePayload {
  quota: { dailyUsed: number; dailyCap: number; cycleUsed: number; cycleCap: number; cycleEnd: string | null }
  plan: { key: string; name: string; monthlyPrice: number } | null
  limits: { monthlySends: number; domains: number; webhooks: number; routes: number; retentionDays: number; dedicatedIp: boolean }
  history: Array<{ day: string; sent: number; delivered: number; bounced: number; failed: number; complained: number }>
}

export default function Usage({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<UsagePayload | null>(null)
  const [billing, setBilling] = useState<BillingPayload | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.get<UsagePayload>(`/t/${tenantId}/usage`).then(setData)
    // Billing is owner-only, so a 403 here is expected for other roles and
    // must not blank the page.
    void api.get<BillingPayload>(`/t/${tenantId}/billing`).then(setBilling).catch(() => setBilling(null))
  }, [tenantId])

  async function choosePlan(key: string) {
    setBusy(key)
    setError(null)
    try {
      const r = await api.post<{ changed: boolean; url: string | null }>(
        `/t/${tenantId}/billing/checkout`, { plan_key: key },
      )
      if (r.url) window.location.href = r.url
      else window.location.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start checkout')
      setBusy(null)
    }
  }

  async function openPortal() {
    setBusy('portal')
    try {
      const r = await api.post<{ url: string }>(`/t/${tenantId}/billing/portal`)
      window.location.href = r.url
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the billing portal')
      setBusy(null)
    }
  }

  if (!data) return <Spinner />

  const { quota, plan, limits, history } = data
  const pct = quota.cycleCap > 0 ? Math.min(1, quota.cycleUsed / quota.cycleCap) : 0
  const peak = Math.max(1, ...history.map((h) => h.sent))
  const limit = (n: number) => (n < 0 ? 'Unlimited' : n.toLocaleString())

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Usage &amp; billing</h1>

      <div className="grid grid-2">
        <Card title="This billing period">
          <div className="stat" style={{ border: 'none', padding: 0 }}>
            <div className="value">{quota.cycleUsed.toLocaleString()}</div>
            <div className="sub">
              of {quota.cycleCap > 0 ? quota.cycleCap.toLocaleString() : 'unlimited'} messages
              {quota.cycleEnd && ` · resets ${new Date(quota.cycleEnd).toLocaleDateString()}`}
            </div>
            {quota.cycleCap > 0 && (
              <div className={`meter ${pct >= 1 ? 'err' : pct >= 0.8 ? 'warn' : ''}`}>
                <i style={{ width: `${pct * 100}%` }} />
              </div>
            )}
          </div>
          {pct >= 0.8 && (
            <p style={{ color: pct >= 1 ? 'var(--err)' : 'var(--warn)', marginTop: 14, marginBottom: 0 }}>
              {pct >= 1
                ? 'You have reached your plan limit. Sending is stopped until you upgrade or the period resets.'
                : 'Approaching your plan limit.'}
            </p>
          )}
        </Card>

        <Card title="Plan">
          {plan ? (
            <>
              <div className="stat" style={{ border: 'none', padding: 0 }}>
                <div className="value" style={{ fontSize: '1.4rem' }}>{plan.name}</div>
                <div className="sub">
                  {plan.monthlyPrice === 0 ? 'No charge' : `$${(plan.monthlyPrice / 100).toFixed(0)} / month`}
                </div>
              </div>
              <table style={{ marginTop: 14 }}>
                <tbody>
                  <tr><td>Messages a month</td><td className="num">{limit(limits.monthlySends)}</td></tr>
                  <tr><td>Sending domains</td><td className="num">{limit(limits.domains)}</td></tr>
                  <tr><td>Webhook endpoints</td><td className="num">{limit(limits.webhooks)}</td></tr>
                  <tr><td>Inbound routes</td><td className="num">{limit(limits.routes)}</td></tr>
                  <tr><td>Message retention</td><td className="num">{limits.retentionDays} days</td></tr>
                  <tr><td>Dedicated IP</td><td>{limits.dedicatedIp ? 'Available' : 'Not on this plan'}</td></tr>
                </tbody>
              </table>
            </>
          ) : (
            <Empty title="No plan assigned" />
          )}
        </Card>
      </div>

      <Card title="Last 30 days">
        {history.length === 0 ? (
          <Empty title="No sending history yet" />
        ) : (
          <>
            {/* Deliberately a bar list rather than a chart library: the shape
                of daily volume is all this needs to communicate. */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, marginBottom: 14 }}>
              {history.map((h) => (
                <div
                  key={h.day}
                  title={`${new Date(h.day).toLocaleDateString()} — ${h.sent} sent, ${h.bounced} bounced`}
                  style={{
                    flex: 1,
                    height: `${Math.max(2, (h.sent / peak) * 100)}%`,
                    background: h.bounced / Math.max(1, h.sent) > 0.05 ? 'var(--warn)' : 'var(--brand)',
                    borderRadius: '3px 3px 0 0',
                    minWidth: 4,
                  }}
                />
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Sent</th><th>Delivered</th><th>Bounced</th><th>Failed</th></tr></thead>
                <tbody>
                  {[...history].reverse().slice(0, 14).map((h) => (
                    <tr key={h.day}>
                      <td>{new Date(h.day).toLocaleDateString()}</td>
                      <td className="num">{h.sent.toLocaleString()}</td>
                      <td className="num">{h.delivered.toLocaleString()}</td>
                      <td className="num">{h.bounced.toLocaleString()}</td>
                      <td className="num">{h.failed.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {billing && (
        <>
          {error && <Banner level="error">{error}</Banner>}

          {!billing.billing_configured && (
            <Banner level="info">
              Billing is not configured on this deployment. Plans are managed by an operator.
            </Banner>
          )}

          {billing.billing_configured && (
            <Card
              title="Change plan"
              action={
                billing.subscription && (
                  <Button onClick={openPortal} disabled={busy === 'portal'}>
                    {busy === 'portal' ? 'Opening…' : 'Payment method & invoices'}
                  </Button>
                )
              }
            >
              <div className="grid grid-3">
                {billing.plans.map((p) => {
                  const current = billing.plan?.key === p.key
                  return (
                    <div key={p.id} className="stat" style={current ? { borderColor: 'var(--brand)' } : undefined}>
                      <div className="label">{p.name}</div>
                      <div className="value" style={{ fontSize: '1.5rem' }}>
                        ${(p.monthlyPrice / 100).toFixed(0)}
                        <span style={{ fontSize: '.8125rem', fontWeight: 500, color: 'var(--ink-3)' }}> /mo</span>
                      </div>
                      <div className="sub">
                        {Number(p.limits.monthlySends ?? 0) < 0
                          ? 'Unlimited messages'
                          : `${Number(p.limits.monthlySends ?? 0).toLocaleString()} messages`}
                      </div>
                      <Button
                        variant={current ? 'ghost' : 'primary'}
                        className="btn-sm"
                        style={{ marginTop: 12, width: '100%' }}
                        disabled={current || busy !== null}
                        onClick={() => choosePlan(p.key)}
                      >
                        {current ? 'Current plan' : busy === p.key ? 'Working…' : 'Switch to this'}
                      </Button>
                    </div>
                  )
                })}
              </div>
              <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
                Changes take effect immediately and are prorated. Downgrading below your
                current usage stops sending until the period resets.
              </p>
            </Card>
          )}

          {billing.invoices.length > 0 && (
            <Card title="Invoices">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {billing.invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="mono">{i.number ?? i.id}</td>
                        <td className="muted">{new Date(i.created).toLocaleDateString()}</td>
                        <td className="num">${(i.amount / 100).toFixed(2)}</td>
                        <td>{i.status}</td>
                        <td style={{ textAlign: 'right' }}>
                          {i.url && <a href={i.url} target="_blank" rel="noreferrer">View</a>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </>
  )
}
