import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, Empty, Spinner } from '../ui'

interface Payload {
  days: number
  daily: Array<{ date: string; sent: number; delivered: number; bounced: number; failed: number; complained: number }>
  by_status: Record<string, number>
  by_tag: Array<{ tag: string | null; count: number }>
  failing_recipient_domains: Array<{ key: string; count: number }>
  failure_reasons: Array<{ key: string; count: number }>
  engagement: { total: number; opened: number; clicked: number }
}

export default function Analytics({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [days, setDays] = useState(30)

  useEffect(() => {
    setData(null)
    void api.get<Payload>(`/t/${tenantId}/analytics?days=${days}`).then(setData)
  }, [tenantId, days])

  if (!data) return <Spinner />

  const peak = Math.max(1, ...data.daily.map((d) => d.sent))
  const totals = data.daily.reduce(
    (a, d) => ({
      sent: a.sent + d.sent,
      delivered: a.delivered + d.delivered,
      bounced: a.bounced + d.bounced,
      failed: a.failed + d.failed,
    }),
    { sent: 0, delivered: 0, bounced: 0, failed: 0 },
  )
  const rate = (n: number) => (totals.sent > 0 ? ((n / totals.sent) * 100).toFixed(2) : '0.00')

  return (
    <>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1>Analytics</h1>
        <span style={{ marginLeft: 'auto' }} />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ maxWidth: 160 }}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Sent</div>
          <div className="value">{totals.sent.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Delivered</div>
          <div className="value">{rate(totals.delivered)}%</div>
          <div className="sub">{totals.delivered.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Bounced</div>
          <div className="value" style={{ color: totals.bounced / Math.max(1, totals.sent) > 0.05 ? 'var(--err)' : undefined }}>
            {rate(totals.bounced)}%
          </div>
          <div className="sub">{totals.bounced.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Failed</div>
          <div className="value">{rate(totals.failed)}%</div>
          <div className="sub">{totals.failed.toLocaleString()}</div>
        </div>
      </div>

      <Card title={`Volume, last ${days} days`}>
        {data.daily.length === 0 ? (
          <Empty title="No sending history yet" />
        ) : (
          <>
            {/* Delivered and bounced are stacked so the bad portion of a day
                is visible against that day's own volume, not a global scale. */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 150 }}>
              {data.daily.map((d) => {
                const h = (d.sent / peak) * 100
                const bad = d.sent > 0 ? ((d.bounced + d.failed) / d.sent) * 100 : 0
                return (
                  <div
                    key={d.date}
                    title={`${new Date(d.date).toLocaleDateString()}\n${d.sent} sent · ${d.bounced} bounced · ${d.failed} failed`}
                    style={{ flex: 1, minWidth: 4, height: `${Math.max(2, h)}%`, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
                  >
                    <div style={{ height: `${100 - bad}%`, background: 'var(--brand)', borderRadius: '3px 3px 0 0' }} />
                    {bad > 0 && <div style={{ height: `${bad}%`, background: 'var(--err)' }} />}
                  </div>
                )
              })}
            </div>
            <div className="row" style={{ marginTop: 12, gap: 16, fontSize: '.8125rem' }}>
              <span className="row" style={{ gap: 6 }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--brand)' }} /> Delivered
              </span>
              <span className="row" style={{ gap: 6 }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--err)' }} /> Bounced or failed
              </span>
            </div>
          </>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="By status">
          {Object.keys(data.by_status).length === 0 ? <Empty title="Nothing sent yet" /> : (
            <table>
              <tbody>
                {Object.entries(data.by_status)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => (
                    <tr key={status}>
                      <td style={{ textTransform: 'capitalize' }}>{status}</td>
                      <td className="num">{count.toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="By tag">
          {data.by_tag.length === 0 ? (
            <Empty title="No tags used">
              <p>Set <code>tag</code> when sending to break volume down by message type.</p>
            </Empty>
          ) : (
            <table>
              <tbody>
                {data.by_tag.map((t) => (
                  <tr key={t.tag ?? 'untagged'}>
                    <td className="mono">{t.tag ?? 'untagged'}</td>
                    <td className="num">{t.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Where failures land">
          {data.failing_recipient_domains.length === 0 ? (
            <Empty title="No failures in this period" />
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Recipient domains rejecting the most mail. One domain dominating usually means a
                reputation problem with that provider specifically, not a broken list.
              </p>
              <table>
                <tbody>
                  {data.failing_recipient_domains.map((d) => (
                    <tr key={d.key}>
                      <td className="mono">{d.key}</td>
                      <td className="num">{d.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>

        <Card title="Why they failed">
          {data.failure_reasons.length === 0 ? (
            <Empty title="No failures in this period" />
          ) : (
            <table>
              <tbody>
                {data.failure_reasons.map((r) => (
                  <tr key={r.key}>
                    <td style={{ fontSize: '.8125rem', fontFamily: 'var(--mono)' }}>{r.key}</td>
                    <td className="num">{r.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Engagement">
        {data.engagement.opened === 0 && data.engagement.clicked === 0 ? (
          <Empty title="Tracking is off">
            <p>Open and click tracking is disabled by default. Enable it per domain if you want it.</p>
          </Empty>
        ) : (
          <div className="grid grid-2">
            <div className="stat" style={{ border: 'none', padding: 0 }}>
              <div className="label">Opened</div>
              <div className="value">
                {((data.engagement.opened / Math.max(1, data.engagement.total)) * 100).toFixed(1)}%
              </div>
              <div className="sub">{data.engagement.opened.toLocaleString()} messages</div>
            </div>
            <div className="stat" style={{ border: 'none', padding: 0 }}>
              <div className="label">Clicked</div>
              <div className="value">
                {((data.engagement.clicked / Math.max(1, data.engagement.total)) * 100).toFixed(1)}%
              </div>
              <div className="sub">{data.engagement.clicked.toLocaleString()} messages</div>
            </div>
          </div>
        )}
      </Card>
    </>
  )
}
