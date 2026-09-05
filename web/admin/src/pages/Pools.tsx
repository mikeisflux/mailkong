import { useEffect, useState } from 'react'
import { api, ApiError, type Operator, type PoolRow } from '../api'
import { Banner, Button, Card, Empty, Field, Spinner } from '../ui'

export default function Pools({ me }: { me: Operator }) {
  const [pools, setPools] = useState<PoolRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [ip, setIp] = useState({ address: '', ptr: '', daily_cap: 500 })

  const canWrite = me.role === 'SUPERADMIN'
  const load = () => api.get<{ data: PoolRow[] }>('/pools').then((r) => setPools(r.data))
  useEffect(() => { void load() }, [])

  async function addIp(e: React.FormEvent) {
    e.preventDefault()
    if (!addingTo) return
    setError(null)
    try {
      await api.post(`/pools/${addingTo}/addresses`, ip)
      setIp({ address: '', ptr: '', daily_cap: 500 })
      setAddingTo(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the address')
    }
  }

  if (!pools) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>IP pools</h1>

      {error && <Banner level="error">{error}</Banner>}
      {!canWrite && <Banner level="info">Your role can view pools but not change them.</Banner>}

      <Card title="Before adding an address">
        <p className="muted" style={{ margin: 0 }}>
          Publish the forward A record first and confirm it resolves, then set the PTR in
          the OVH control panel — OVH validates the forward record before accepting a
          reverse. Check the address against Spamhaus and Barracuda before it carries any
          traffic. New addresses always start warming with a low cap.
        </p>
      </Card>

      {pools.length === 0 ? (
        <Card><Empty title="No pools yet" /></Card>
      ) : (
        pools.map((p) => (
          <Card
            key={p.id}
            title={p.name}
            action={
              canWrite && (
                <Button className="btn-sm" onClick={() => setAddingTo(addingTo === p.id ? null : p.id)}>
                  {addingTo === p.id ? 'Cancel' : 'Add IP'}
                </Button>
              )
            }
          >
            <p className="muted" style={{ marginTop: 0 }}>
              {p.kind.toLowerCase().replace('_', ' ')}
              {p.tenant && <> · dedicated to <strong>{p.tenant.name}</strong></>}
              {' · '}{p.servers.length} server{p.servers.length === 1 ? '' : 's'} sending through it
            </p>

            {addingTo === p.id && (
              <form onSubmit={addIp} style={{ marginBottom: 16 }}>
                <div className="grid grid-3">
                  <Field label="IPv4 address"><input value={ip.address} onChange={(e) => setIp({ ...ip, address: e.target.value })} placeholder="203.0.113.10" required /></Field>
                  <Field label="PTR hostname"><input value={ip.ptr} onChange={(e) => setIp({ ...ip, ptr: e.target.value })} placeholder="mta1.mailkong.net" required /></Field>
                  <Field label="Warm-up daily cap"><input type="number" value={ip.daily_cap} onChange={(e) => setIp({ ...ip, daily_cap: Number(e.target.value) })} /></Field>
                </div>
                <Button type="submit" variant="primary">Add address</Button>
              </form>
            )}

            {p.addresses.length === 0 ? (
              <Empty title="No addresses in this pool" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Address</th><th>PTR</th><th>State</th><th>Warm-up cap</th></tr></thead>
                  <tbody>
                    {p.addresses.map((a) => (
                      <tr key={a.id}>
                        <td className="mono">{a.address}</td>
                        <td className="mono">{a.ptr ?? <span className="muted">not set</span>}</td>
                        <td>
                          {a.warming
                            ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>Warming</span>
                            : <span style={{ color: 'var(--ok)', fontWeight: 600 }}>Live</span>}
                        </td>
                        <td className="num">{a.warming ? (a.dailyCap?.toLocaleString() ?? '—') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ))
      )}
    </>
  )
}
