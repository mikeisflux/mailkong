import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Overview as Data } from '../api'
import { Banner, Card, Empty, Spinner } from '../ui'

export default function Overview() {
  const [data, setData] = useState<Data | null>(null)
  useEffect(() => { void api.get<Data>('/overview').then(setData) }, [])
  if (!data) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Ops overview</h1>

      {!data.health.postal_reachable && (
        <Banner level="error">
          <strong>Postal is unreachable.</strong> Sending and provisioning are both down.
          Check the mail box before anything else.
        </Banner>
      )}
      {data.ips.listed > 0 && (
        <Banner level="error">
          <strong>{data.ips.listed} sending IP{data.ips.listed === 1 ? ' is' : 's are'} on a blocklist.</strong>{' '}
          Mail is being rejected now. <Link to="/ips">Review</Link>
        </Banner>
      )}
      {data.accounts.failed_charges > 0 && (
        <Banner level="warning">
          {data.accounts.failed_charges} invoice{data.accounts.failed_charges === 1 ? '' : 's'} failed to charge.{' '}
          <Link to="/billing">Review</Link>
        </Banner>
      )}
      {data.accounts.open_abuse > 0 && (
        <Banner level="warning">
          {data.accounts.open_abuse} open abuse {data.accounts.open_abuse === 1 ? 'ticket' : 'tickets'}.{' '}
          <Link to="/abuse">Review</Link>
        </Banner>
      )}

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Sent, last hour</div>
          <div className="value">{data.sends.last_hour.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Sent, last 24h</div>
          <div className="value">{data.sends.last_24h.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="label">Bounce rate, 24h</div>
          <div className="value" style={{ color: data.health.bounce_rate > 0.05 ? 'var(--err)' : undefined }}>
            {(data.health.bounce_rate * 100).toFixed(1)}%
          </div>
          <div className="sub">{data.health.held} held</div>
        </div>
        <div className="stat">
          <div className="label">Accounts needing attention</div>
          <div className="value">{data.accounts.past_due + data.accounts.paused}</div>
          <div className="sub">{data.accounts.past_due} past due · {data.accounts.paused} paused</div>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Sending IPs</div>
          <div className="value">{data.ips.total}</div>
          <div className="sub">{data.ips.warming} warming</div>
        </div>
        <div className="stat">
          <div className="label">Blocklisted</div>
          <div className="value" style={{ color: data.ips.listed > 0 ? 'var(--err)' : undefined }}>
            {data.ips.listed}
          </div>
        </div>
        <div className="stat">
          <div className="label">Failed charges</div>
          <div className="value" style={{ color: data.accounts.failed_charges > 0 ? 'var(--warn)' : undefined }}>
            {data.accounts.failed_charges}
          </div>
        </div>
      </div>

      <Card title="IP pools" action={<Link to="/pools">Manage</Link>}>
        {data.pools.length === 0 ? (
          <Empty title="No IP pools">
            <p>Create shared-tx and add your sending addresses once OVH delivers them.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Pool</th><th>Kind</th><th>Addresses</th><th>Warming</th><th>Servers using it</th></tr>
              </thead>
              <tbody>
                {data.pools.map((p) => (
                  <tr key={p.id}>
                    <td style={{ color: 'var(--ink)', fontWeight: 600 }}>{p.name}</td>
                    <td>{p.kind.toLowerCase().replace('_', ' ')}</td>
                    <td className="num">{p.addresses}</td>
                    <td className="num">{p.warming > 0 ? <span style={{ color: 'var(--warn)' }}>{p.warming}</span> : '—'}</td>
                    <td className="num">{p.servers}</td>
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
