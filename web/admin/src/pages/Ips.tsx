import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type Operator } from '../api'
import { Banner, Button, Card, Empty, Spinner, relative } from '../ui'

interface BlocklistResult {
  zone: string
  name: string
  severity: 'critical' | 'warning' | 'info'
  listed: boolean
  answer: string | null
  usable: boolean
}

interface Row {
  id: string
  address: string
  ptr: string | null
  warming: boolean
  daily_cap: number | null
  pool: { id: string; name: string; kind: string; tenant: { id: string; name: string } | null }
  volume_24h: number
  volume_7d: number
  last_blacklist_check_at: string | null
  blacklist_status: BlocklistResult[] | null
}

interface Payload {
  attribution: { attributed: number; total: number; reliable: boolean }
  data: Row[]
}

export default function Ips({ me }: { me: Operator }) {
  const [payload, setPayload] = useState<Payload | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outbound, setOutbound] = useState<Array<{ ip: string; ptr: string | null; ptrMatches: boolean | null; forwardConfirmed: boolean | null; error: string | null }> | null>(null)

  const canWrite = me.role === 'SUPERADMIN'
  const load = () => api.get<Payload>('/ips').then(setPayload)
  useEffect(() => { void load() }, [])

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  if (!payload) return <Spinner />

  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <h1>Sending IPs</h1>
        <span style={{ marginLeft: 'auto' }} />
        <Button
          disabled={busy !== null}
          onClick={() => act('outbound', async () => {
            const r = await api.post<{ results: typeof outbound }>('/system/outbound-test')
            setOutbound(r.results)
          })}
        >
          {busy === 'outbound' ? 'Testing…' : 'Outbound test'}
        </Button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Every address that carries mail. Reverse DNS and blocklist status are what decide
        whether these deliver at all.
      </p>

      {error && <Banner level="error">{error}</Banner>}

      {!payload.attribution.reliable && payload.attribution.total > 0 && (
        <Banner level="info">
          Per-IP volume is attributed from Postal's delivery line, which only names the
          sending address on some events. Only{' '}
          {Math.round((payload.attribution.attributed / payload.attribution.total) * 100)}% of
          the last week's messages could be attributed, so treat these counts as a floor
          rather than a total.
        </Banner>
      )}

      {outbound && (
        <Card title="Outbound test" action={<Button className="btn-sm" onClick={() => setOutbound(null)}>Close</Button>}>
          <p className="muted" style={{ marginTop: 0 }}>
            Checks forward-confirmed reverse DNS, which is what Gmail and Microsoft actually
            require. A PTR that was right on provisioning day can be silently wrong after an
            address is reassigned.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>Resolved PTR</th><th>Matches expected</th><th>Forward-confirmed</th></tr></thead>
              <tbody>
                {outbound.map((o) => (
                  <tr key={o.ip}>
                    <td className="mono">{o.ip}</td>
                    <td className="mono">{o.ptr ?? <span style={{ color: 'var(--err)' }}>none</span>}</td>
                    <td>{o.ptrMatches === null ? '—' : o.ptrMatches
                      ? <span style={{ color: 'var(--ok)', fontWeight: 600 }}>yes</span>
                      : <span style={{ color: 'var(--err)', fontWeight: 600 }}>no</span>}</td>
                    <td>{o.forwardConfirmed
                      ? <span style={{ color: 'var(--ok)', fontWeight: 600 }}>yes</span>
                      : <span style={{ color: 'var(--err)', fontWeight: 600 }}>no — mail will be deferred</span>}
                      {o.error && <div className="muted" style={{ fontSize: '.75rem' }}>{o.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {payload.data.length === 0 ? (
        <Card>
          <Empty title="No sending addresses yet">
            <p>Add them to a pool once OVH delivers them, after checking each against blocklists.</p>
          </Empty>
        </Card>
      ) : (
        payload.data.map((ip) => {
          const results = ip.blacklist_status ?? []
          const listed = results.filter((r) => r.listed)
          const unusable = results.filter((r) => !r.usable)

          return (
            <Card
              key={ip.id}
              title={ip.address}
              action={
                <div className="row">
                  {listed.length > 0 && (
                    <span className="status status-err">listed on {listed.length}</span>
                  )}
                  <Button
                    className="btn-sm"
                    disabled={busy !== null}
                    onClick={() => act(ip.id, () => api.post(`/ips/${ip.id}/check-blocklists`))}
                  >
                    {busy === ip.id ? 'Checking…' : 'Check blocklists'}
                  </Button>
                  {canWrite && (
                    <Button
                      className="btn-sm"
                      onClick={() => act(ip.id, () => api.patch(`/ips/${ip.id}`, { warming: !ip.warming }))}
                    >
                      {ip.warming ? 'Mark warmed' : 'Mark warming'}
                    </Button>
                  )}
                </div>
              }
            >
              <div className="grid grid-4" style={{ marginBottom: 14 }}>
                <div>
                  <div className="label muted" style={{ fontSize: '.75rem', textTransform: 'uppercase' }}>Reverse DNS</div>
                  <div className="mono">{ip.ptr ?? <span style={{ color: 'var(--err)' }}>not set</span>}</div>
                </div>
                <div>
                  <div className="label muted" style={{ fontSize: '.75rem', textTransform: 'uppercase' }}>Pool</div>
                  <div>
                    {ip.pool.name}
                    {ip.pool.tenant && (
                      <> · <Link to={`/tenants/${ip.pool.tenant.id}`}>{ip.pool.tenant.name}</Link></>
                    )}
                  </div>
                </div>
                <div>
                  <div className="label muted" style={{ fontSize: '.75rem', textTransform: 'uppercase' }}>Volume 24h / 7d</div>
                  <div className="tabular">{ip.volume_24h.toLocaleString()} / {ip.volume_7d.toLocaleString()}</div>
                </div>
                <div>
                  <div className="label muted" style={{ fontSize: '.75rem', textTransform: 'uppercase' }}>State</div>
                  <div>
                    {ip.warming
                      ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
                          Warming{ip.daily_cap ? ` · ${ip.daily_cap.toLocaleString()}/day` : ''}
                        </span>
                      : <span style={{ color: 'var(--ok)', fontWeight: 600 }}>Live</span>}
                  </div>
                </div>
              </div>

              {results.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Never checked against blocklists.</p>
              ) : (
                <>
                  <div className="row" style={{ gap: 8 }}>
                    {results.map((r) => (
                      <span
                        key={r.zone}
                        className={`check ${r.listed ? 'check-no' : r.usable ? 'check-ok' : 'check-no'}`}
                        style={r.listed ? { background: 'var(--err-wash)', color: 'var(--err)' } : undefined}
                        title={r.answer ?? ''}
                      >
                        {r.listed ? '✗' : r.usable ? '✓' : '?'} {r.name}
                      </span>
                    ))}
                  </div>
                  <p className="muted" style={{ marginBottom: 0, marginTop: 10, fontSize: '.8125rem' }}>
                    Checked {ip.last_blacklist_check_at ? relative(ip.last_blacklist_check_at) : 'never'}.
                  </p>
                </>
              )}

              {unusable.length > 0 && (
                <Banner level="warning">
                  {unusable.map((u) => u.name).join(', ')} refused our resolver, so those results
                  mean nothing. Box A must use a local recursive resolver — Spamhaus and others
                  answer NXDOMAIN to public resolvers, which reads as "clean".
                </Banner>
              )}
            </Card>
          )
        })
      )}
    </>
  )
}
