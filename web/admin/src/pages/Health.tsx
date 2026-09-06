import { useEffect, useState } from 'react'
import { api } from '../api'
import { Banner, Card, Spinner } from '../ui'

interface Payload {
  postal: { reachable: boolean; queued: number | null; held: number | null; workers: number | null }
  control_plane: {
    messages_24h: number
    stuck_queued: number
    oldest_queued_at: string | null
    database_size: string | null
    database_bytes: number
  }
  webhooks: {
    attempts_last_hour: number
    failures_last_hour: number
    failure_rate: number
    disabled_endpoints: number
  }
  certificates: Array<{ host: string; port: number; ok: boolean; expiresAt: string | null; daysRemaining: number | null; issuer: string | null; error: string | null }>
  blocklisted: Array<{ address: string; list: string; checked_at: string | null }>
  alerts: Array<{ level: 'warning' | 'critical'; message: string }>
}

export default function Health() {
  const [data, setData] = useState<Payload | null>(null)

  useEffect(() => {
    const load = () => void api.get<Payload>('/health/detail').then(setData)
    load()
    // Fast enough to watch a queue drain during an incident.
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [])

  if (!data) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 6 }}>Queues &amp; health</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Refreshes every 15 seconds. These are the same thresholds that page on-call.
      </p>

      {data.alerts.length === 0 ? (
        <Banner level="info">Nothing is firing. All checks are inside their thresholds.</Banner>
      ) : (
        data.alerts.map((a, i) => (
          <Banner key={i} level={a.level === 'critical' ? 'error' : 'warning'}>
            <strong>{a.level === 'critical' ? 'Critical: ' : 'Warning: '}</strong>{a.message}
          </Banner>
        ))
      )}

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Postal</div>
          <div className="value" style={{ fontSize: '1.25rem', color: data.postal.reachable ? 'var(--ok)' : 'var(--err)' }}>
            {data.postal.reachable ? 'Reachable' : 'Down'}
          </div>
          <div className="sub">{data.postal.workers ?? '—'} workers</div>
        </div>
        <div className="stat">
          <div className="label">Postal queue</div>
          <div className="value">{data.postal.queued?.toLocaleString() ?? '—'}</div>
          <div className="sub">{data.postal.held ?? 0} held</div>
        </div>
        <div className="stat">
          <div className="label">Stuck over an hour</div>
          <div className="value" style={{ color: data.control_plane.stuck_queued > 0 ? 'var(--err)' : undefined }}>
            {data.control_plane.stuck_queued.toLocaleString()}
          </div>
          <div className="sub">
            {data.control_plane.oldest_queued_at
              ? `oldest ${new Date(data.control_plane.oldest_queued_at).toLocaleString()}`
              : 'nothing queued'}
          </div>
        </div>
        <div className="stat">
          <div className="label">Messages, 24h</div>
          <div className="value">{data.control_plane.messages_24h.toLocaleString()}</div>
        </div>
      </div>

      <Card title="Certificates">
        <p className="muted" style={{ marginTop: 0 }}>
          Checked from outside, the way a customer's client sees them — a renewed certificate
          that nginx never reloaded still serves the old one.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Host</th><th>Port</th><th>Expires</th><th>Days left</th><th>Issuer</th></tr></thead>
            <tbody>
              {data.certificates.map((c) => (
                <tr key={`${c.host}:${c.port}`}>
                  <td className="mono">{c.host}</td>
                  <td className="num">{c.port}</td>
                  <td className="muted">{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : '—'}</td>
                  <td
                    className="num"
                    style={{
                      color:
                        c.daysRemaining === null ? undefined
                        : c.daysRemaining <= 7 ? 'var(--err)'
                        : c.daysRemaining <= 21 ? 'var(--warn)'
                        : 'var(--ok)',
                      fontWeight: 600,
                    }}
                  >
                    {c.daysRemaining ?? '—'}
                  </td>
                  <td className="muted">{c.error ?? c.issuer ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {data.blocklisted.length > 0 && (
        <Card title="Blocklisted sending IPs">
          <Banner level="error">
            Mail from these addresses is being rejected right now. Every hour on a list makes
            delisting harder — request it immediately.
          </Banner>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>List</th><th>Detected</th></tr></thead>
              <tbody>
                {data.blocklisted.map((b, i) => (
                  <tr key={i}>
                    <td className="mono">{b.address}</td>
                    <td>{b.list}</td>
                    <td className="muted">{b.checked_at ? new Date(b.checked_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid grid-2">
        <Card title="Webhook delivery, last hour">
          <table>
            <tbody>
              <tr><td>Attempts</td><td className="num">{data.webhooks.attempts_last_hour.toLocaleString()}</td></tr>
              <tr><td>Failures</td><td className="num">{data.webhooks.failures_last_hour.toLocaleString()}</td></tr>
              <tr>
                <td>Failure rate</td>
                <td className="num" style={{ color: data.webhooks.failure_rate > 0.5 ? 'var(--warn)' : undefined }}>
                  {(data.webhooks.failure_rate * 100).toFixed(1)}%
                </td>
              </tr>
              <tr><td>Endpoints auto-disabled</td><td className="num">{data.webhooks.disabled_endpoints}</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
            A high failure rate is usually one customer endpoint down and retrying, not a fault
            here. Check the delivery log on the tenant before assuming otherwise.
          </p>
        </Card>

        <Card title="Control-plane database">
          <div className="stat" style={{ border: 'none', padding: 0 }}>
            <div className="value" style={{ fontSize: '1.5rem' }}>{data.control_plane.database_size ?? '—'}</div>
            <div className="sub">message index, accounts, audit log</div>
          </div>
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Message <em>bodies</em> live in Postal on Box B, not here. If this grows past a few
            gigabytes, check that the maintenance job is pruning the index at each tenant's
            retention limit.
          </p>
        </Card>
      </div>
    </>
  )
}
