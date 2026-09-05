import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Button, Card, Empty, Status, relative } from '../ui'

interface Row {
  id: string
  to: string
  from: string
  subject: string | null
  status: string
  postalMessageId: string | null
  createdAt: string
  tenant: { id: string; name: string; slug: string; status: string }
}

/**
 * Spec 9.2: "Used when someone mails abuse@ and you need the tenant in 30
 * seconds." Search is deliberately across every tenant.
 */
export default function Messages() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function search(e: React.FormEvent) {
    e.preventDefault()
    if (q.trim().length < 2) return
    setBusy(true)
    try {
      setRows((await api.get<{ data: Row[] }>(`/messages?search=${encodeURIComponent(q)}`)).data)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Global message search</h1>

      <Card>
        <form onSubmit={search} className="row">
          <input
            placeholder="Recipient, sender, message id, or Postal token"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 460 }}
            autoFocus
          />
          <Button type="submit" variant="primary" disabled={busy || q.trim().length < 2}>
            {busy ? 'Searching…' : 'Search'}
          </Button>
        </form>
      </Card>

      {rows && (
        <Card>
          {rows.length === 0 ? (
            <Empty title="Nothing found">
              <p>Message indexes are pruned at each tenant's retention limit.</p>
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>When</th><th>Tenant</th><th>To</th><th>From</th><th>Subject</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id}>
                      <td className="muted">{relative(m.createdAt)}</td>
                      <td>
                        <Link to={`/tenants/${m.tenant.id}`}>{m.tenant.name}</Link>
                        <div><Status value={m.tenant.status} /></div>
                      </td>
                      <td className="mono">{m.to}</td>
                      <td className="mono">{m.from}</td>
                      <td>{m.subject ?? <span className="muted">(none)</span>}</td>
                      <td><Status value={m.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  )
}
