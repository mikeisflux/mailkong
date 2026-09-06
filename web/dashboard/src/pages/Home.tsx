import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Overview } from '../api'
import { Banner, Card, Check, Empty, Spinner, Status, relative } from '../ui'

export default function Home({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<Overview | null>(null)

  useEffect(() => {
    void api.get<Overview>(`/t/${tenantId}/overview`).then(setData)
  }, [tenantId])

  if (!data) return <Spinner />

  const { quota, last24h } = data
  const cyclePct = quota.cycleCap > 0 ? Math.min(1, quota.cycleUsed / quota.cycleCap) : 0
  const dailyPct = quota.dailyCap > 0 ? Math.min(1, quota.dailyUsed / quota.dailyCap) : 0

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Overview</h1>

      {data.alerts.map((a, i) => (
        <Banner key={i} level={a.level}>{a.message}</Banner>
      ))}

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Sent, last 24h</div>
          <div className="value">{last24h.total.toLocaleString()}</div>
        </div>

        <div className="stat">
          <div className="label">Bounce rate</div>
          <div className="value">{(last24h.bounce_rate * 100).toFixed(1)}%</div>
          <div className="sub">{last24h.bounced} bounced</div>
        </div>

        <div className="stat">
          <div className="label">This month</div>
          <div className="value">{quota.cycleUsed.toLocaleString()}</div>
          <div className="sub">
            of {quota.cycleCap > 0 ? quota.cycleCap.toLocaleString() : 'unlimited'}
          </div>
          {quota.cycleCap > 0 && (
            <div className={`meter ${cyclePct >= 1 ? 'err' : cyclePct >= 0.8 ? 'warn' : ''}`}>
              <i style={{ width: `${cyclePct * 100}%` }} />
            </div>
          )}
        </div>

        <div className="stat">
          <div className="label">Today</div>
          <div className="value">{quota.dailyUsed.toLocaleString()}</div>
          <div className="sub">daily cap {quota.dailyCap.toLocaleString()}</div>
          <div className={`meter ${dailyPct >= 1 ? 'err' : dailyPct >= 0.8 ? 'warn' : ''}`}>
            <i style={{ width: `${dailyPct * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <Card title="Domains" action={<Link to={`/t/${tenantId}/domains`}>Manage</Link>}>
          {data.domains.length === 0 ? (
            <Empty title="No domains yet" />
          ) : (
            data.domains.map((d) => (
              <div key={d.id} className="row" style={{ padding: '7px 0', justifyContent: 'space-between' }}>
                <strong style={{ color: 'var(--ink)' }}>{d.name}</strong>
                <span className="row" style={{ gap: 6 }}>
                  <Check ok={d.spf} label="SPF" />
                  <Check ok={d.dkim} label="DKIM" />
                  <Check ok={d.dmarc} label="DMARC" />
                </span>
              </div>
            ))
          )}
        </Card>

        <Card title="Queue">
          {data.queue.queued + data.queue.deferred + data.queue.held === 0 ? (
            <Empty title="Nothing waiting">
              <p>Every message has left the queue.</p>
            </Empty>
          ) : (
            <>
              <table>
                <tbody>
                  <tr><td>Queued</td><td className="num">{data.queue.queued.toLocaleString()}</td></tr>
                  <tr><td>Deferred and retrying</td><td className="num">{data.queue.deferred.toLocaleString()}</td></tr>
                  <tr><td>Held</td><td className="num">{data.queue.held.toLocaleString()}</td></tr>
                </tbody>
              </table>
              {data.queue.deferred > 0 && (
                <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
                  Deferred means the receiving server asked us to try later. This is normal in
                  small numbers and usually resolves itself.
                </p>
              )}
            </>
          )}
        </Card>

        <Card title="Delivery, last 24h">
          {Object.keys(last24h.by_status).length === 0 ? (
            <Empty title="Nothing sent yet" />
          ) : (
            Object.entries(last24h.by_status).map(([status, count]) => (
              <div key={status} className="row" style={{ padding: '7px 0', justifyContent: 'space-between' }}>
                <Status value={status} />
                <span className="tabular" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                  {count.toLocaleString()}
                </span>
              </div>
            ))
          )}
        </Card>
      </div>

      <Card title="Recent messages" action={<Link to={`/t/${tenantId}/activity`}>All activity</Link>}>
        {data.recent.length === 0 ? (
          <Empty title="No messages yet">
            <p>Send a test message to see it appear here.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>To</th><th>Subject</th><th>Status</th><th>When</th></tr>
              </thead>
              <tbody>
                {data.recent.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.to}</td>
                    <td>{m.subject ?? <span className="muted">(no subject)</span>}</td>
                    <td><Status value={m.status} /></td>
                    <td className="muted">{relative(m.created_at)}</td>
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
