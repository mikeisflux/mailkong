import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type Operator } from '../api'
import { Banner, Button, Card, Empty, Field, Spinner, relative } from '../ui'

interface Row {
  id: string
  email: string
  reason: string
  detail: string | null
  tenant: { id: string; name: string; slug: string } | null
  global: boolean
  created_at: string
}

export default function Suppressions({ me }: { me: Operator }) {
  const [payload, setPayload] = useState<{ counts: { global: number; tenant: number }; data: Row[] } | null>(null)
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState('all')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  const canWrite = ['SUPERADMIN', 'SUPPORT'].includes(me.role)

  const load = useCallback(async () => {
    const params = new URLSearchParams({ scope })
    if (search) params.set('search', search)
    setPayload(await api.get(`/suppressions?${params}`))
  }, [search, scope])

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, search])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed')
    }
  }

  return (
    <>
      <h1 style={{ marginBottom: 6 }}>Suppressions</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        A platform-wide suppression blocks an address for every tenant. Use it for addresses
        that complain repeatedly across customers, not for one customer's bad list.
      </p>

      {error && <Banner level="error">{error}</Banner>}

      {canWrite && (
        <Card title="Suppress platform-wide">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              void act(async () => {
                await api.post('/suppressions', { email, tenant_id: null, reason: 'MANUAL' })
                setEmail('')
              })
            }}
          >
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ minWidth: 300 }} />
            </Field>
            <Button type="submit" variant="danger" style={{ marginBottom: 14 }}>
              Suppress everywhere
            </Button>
          </form>
        </Card>
      )}

      <Card>
        <div className="row">
          <input
            placeholder="Search address"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="all">All ({(payload?.counts.global ?? 0) + (payload?.counts.tenant ?? 0)})</option>
            <option value="global">Platform-wide ({payload?.counts.global ?? 0})</option>
            <option value="tenant">Per tenant ({payload?.counts.tenant ?? 0})</option>
          </select>
        </div>
      </Card>

      <Card>
        {!payload ? <Spinner /> : payload.data.length === 0 ? (
          <Empty title="Nothing matches" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>Scope</th><th>Reason</th><th>Added</th><th /></tr></thead>
              <tbody>
                {payload.data.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.email}</td>
                    <td>
                      {s.global
                        ? <span style={{ color: 'var(--err)', fontWeight: 600 }}>platform-wide</span>
                        : s.tenant
                          ? <Link to={`/tenants/${s.tenant.id}`}>{s.tenant.name}</Link>
                          : '—'}
                    </td>
                    <td>
                      {s.reason.toLowerCase().replace(/_/g, ' ')}
                      {s.detail && <div className="muted" style={{ fontSize: '.75rem', maxWidth: 300 }}>{s.detail}</div>}
                    </td>
                    <td className="muted">{relative(s.created_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {canWrite && s.global && (
                        <Button
                          className="btn-sm"
                          onClick={() => act(() => api.del(`/suppressions/${encodeURIComponent(s.email)}`))}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
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
