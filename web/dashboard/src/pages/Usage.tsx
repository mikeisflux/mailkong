import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, Empty, Spinner } from '../ui'

interface UsagePayload {
  quota: { dailyUsed: number; dailyCap: number; cycleUsed: number; cycleCap: number; cycleEnd: string | null }
  plan: { key: string; name: string; monthlyPrice: number } | null
  limits: { monthlySends: number; domains: number; webhooks: number; routes: number; retentionDays: number; dedicatedIp: boolean }
  history: Array<{ day: string; sent: number; delivered: number; bounced: number; failed: number; complained: number }>
}

export default function Usage({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<UsagePayload | null>(null)
  useEffect(() => { void api.get<UsagePayload>(`/t/${tenantId}/usage`).then(setData) }, [tenantId])

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
    </>
  )
}
