import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AuditRow } from '../api'
import { Card, Empty, Spinner, relative } from '../ui'

export default function Audit() {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [action, setAction] = useState('')

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (action) params.set('action', action)
    setRows((await api.get<{ data: AuditRow[] }>(`/audit?${params}`)).data)
  }, [action])

  useEffect(() => {
    const t = setTimeout(() => void load(), action ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, action])

  return (
    <>
      <h1 style={{ marginBottom: 6 }}>Audit log</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Append-only. Nothing in the application updates or deletes these rows.
      </p>

      <Card>
        <input
          placeholder="Filter by action, e.g. tenant.paused"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          style={{ maxWidth: 340 }}
        />
      </Card>

      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? (
          <Empty title="No matching events" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Tenant</th><th>Detail</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{relative(r.createdAt)}</td>
                    <td className="mono" style={{ color: 'var(--ink)' }}>{r.action}</td>
                    <td className="mono">{r.admin?.email ?? <span className="muted">system</span>}</td>
                    <td>{r.tenant ? <Link to={`/tenants/${r.tenant.id}`}>{r.tenant.name}</Link> : <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: '.75rem', maxWidth: 320, overflowWrap: 'anywhere' }}>
                      {r.payload ? JSON.stringify(r.payload) : '—'}
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
