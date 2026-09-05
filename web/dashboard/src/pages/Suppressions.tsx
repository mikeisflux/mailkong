import { useEffect, useState } from 'react'
import { api } from '../api'
import { Button, Card, Empty, Spinner, relative } from '../ui'

interface Suppression {
  id: string
  email: string
  reason: string
  detail: string | null
  tenantId: string | null
  createdAt: string
}

export default function Suppressions({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = useState<Suppression[] | null>(null)
  const [email, setEmail] = useState('')

  const load = () => api.get<{ data: Suppression[] }>(`/t/${tenantId}/suppressions`).then((r) => setRows(r.data))
  useEffect(() => { void load() }, [tenantId])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    await api.post(`/t/${tenantId}/suppressions`, { email })
    setEmail('')
    await load()
  }

  async function remove(s: Suppression) {
    if (s.tenantId === null) {
      alert('This is a platform-wide suppression and cannot be removed from here. Contact support if you believe it is wrong.')
      return
    }
    await api.del(`/t/${tenantId}/suppressions/${encodeURIComponent(s.email)}`)
    await load()
  }

  function exportCsv() {
    if (!rows) return
    const csv = ['email,reason,added_at', ...rows.map((r) => `${r.email},${r.reason},${r.createdAt}`)].join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'suppressions.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!rows) return <Spinner />

  return (
    <>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1>Suppressions</h1>
        <span style={{ marginLeft: 'auto' }} />
        <Button onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>
      </div>

      <Card title="Add an address">
        <form onSubmit={add} className="row">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="never-send@example.com"
            required
            style={{ maxWidth: 340 }}
          />
          <Button type="submit" variant="primary">Suppress</Button>
        </form>
        <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
          Hard bounces and spam complaints are added here automatically. Sends to a
          suppressed address are dropped before they reach the mail engine.
        </p>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <Empty title="Nothing suppressed">
            <p>Good sign — no hard bounces or complaints so far.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>Reason</th><th>Added</th><th /></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.email}</td>
                    <td>
                      {s.reason.toLowerCase().replace(/_/g, ' ')}
                      {s.tenantId === null && <span className="muted"> · platform-wide</span>}
                    </td>
                    <td className="muted">{relative(s.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Button className="btn-sm" onClick={() => remove(s)}>Remove</Button>
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
