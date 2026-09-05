import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type TenantRow } from '../api'
import { Card, Empty, Spinner, Status } from '../ui'

const STATUSES = ['', 'ACTIVE', 'PAUSED_PENDING_DOMAIN', 'PAST_DUE', 'PAUSED', 'DISABLED']

export default function Tenants() {
  const [rows, setRows] = useState<TenantRow[] | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (status) params.set('status', status)
    setRows((await api.get<{ data: TenantRow[] }>(`/tenants?${params}`)).data)
  }, [search, status])

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, search])

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Tenants</h1>

      <Card>
        <div className="row">
          <input
            placeholder="Search by name, slug, owner email, or domain"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 380 }}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 220 }}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s === '' ? 'All statuses' : s.toLowerCase().replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
      </Card>

      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? (
          <Empty title="No tenants match" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Organization</th><th>Plan</th><th>Status</th>
                  <th>Sends this cycle</th><th>Daily cap</th><th>Domains</th><th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link to={`/tenants/${t.id}`} style={{ fontWeight: 600 }}>{t.name}</Link>
                      <div className="muted" style={{ fontSize: '.75rem' }}>{t.slug}</div>
                    </td>
                    <td>{t.plan ?? <span className="muted">none</span>}</td>
                    <td>
                      <Status value={t.status} />
                      {t.status_reason && (
                        <div className="muted" style={{ fontSize: '.75rem', maxWidth: 220 }}>{t.status_reason}</div>
                      )}
                    </td>
                    <td className="num">{t.sends_this_cycle.toLocaleString()}</td>
                    <td className="num">{t.daily_cap.toLocaleString()}</td>
                    <td className="num">{t.domains}</td>
                    <td className="muted">{new Date(t.created_at).toLocaleDateString()}</td>
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
