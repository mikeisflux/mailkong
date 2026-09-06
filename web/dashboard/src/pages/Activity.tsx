import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type Message } from '../api'
import { Banner, Button, Card, Empty, Spinner, Status, relative } from '../ui'

const STATUSES = ['', 'queued', 'sent', 'delivered', 'bounced', 'failed', 'held']

export default function Activity({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = useState<Message[] | null>(null)
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Message | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (search) params.set('search', search)
    const r = await api.get<{ data: Message[] }>(`/t/${tenantId}/activity?${params}`)
    setRows(r.data)
  }, [tenantId, status, search])

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, search])

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Activity</h1>

      {notice && <Banner level="info">{notice}</Banner>}
      {error && <Banner level="error">{error}</Banner>}

      <Card>
        <div className="row">
          <input
            placeholder="Search recipient, subject or tag"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 340 }}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 170 }}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s === '' ? 'All statuses' : s}</option>
            ))}
          </select>
          <Button onClick={() => void load()}>Refresh</Button>
        </div>
      </Card>

      {selected && (
        <Card
          title="Message detail"
          action={
            <div className="row">
              {['bounced', 'failed', 'held'].includes(selected.status.toLowerCase()) && (
                <Button
                  variant="primary"
                  className="btn-sm"
                  onClick={async () => {
                    setError(null)
                    try {
                      const r = await api.post<{ id: string }>(`/t/${tenantId}/activity/${selected.id}/resend`)
                      setNotice(`Resent as ${r.id}.`)
                      await load()
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : 'Could not resend')
                    }
                  }}
                >
                  Resend
                </Button>
              )}
              <Button className="btn-sm" onClick={() => setSelected(null)}>Close</Button>
            </div>
          }
        >
          <div className="grid grid-2">
            <div>
              <p><strong>To</strong><br /><code>{selected.to}</code></p>
              <p><strong>From</strong><br /><code>{selected.from}</code></p>
              <p><strong>Subject</strong><br />{selected.subject ?? <span className="muted">(none)</span>}</p>
            </div>
            <div>
              <p><strong>Status</strong><br /><Status value={selected.status} /></p>
              <p><strong>Tag</strong><br />{selected.tag ?? <span className="muted">none</span>}</p>
              <p><strong>Created</strong><br />{new Date(selected.createdAt).toLocaleString()}</p>
            </div>
          </div>
          {selected.bounceReason && (
            <>
              <strong>Response from the receiving server</strong>
              <pre style={{ background: 'var(--bg-3)', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: '.8125rem' }}>
                {selected.bounceReason}
              </pre>
            </>
          )}
        </Card>
      )}

      <Card>
        {!rows ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty title="No messages match" >
            <p>Try clearing the filters, or send a test message.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>To</th><th>Subject</th><th>Tag</th><th>Status</th></tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} onClick={() => setSelected(m)} style={{ cursor: 'pointer' }}>
                    <td className="muted">{relative(m.createdAt)}</td>
                    <td className="mono">{m.to}</td>
                    <td>{m.subject ?? <span className="muted">(no subject)</span>}</td>
                    <td className="muted">{m.tag ?? '—'}</td>
                    <td><Status value={m.status} /></td>
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
