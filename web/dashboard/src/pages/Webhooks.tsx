import { useEffect, useState } from 'react'
import { api, ApiError, type WebhookEndpoint } from '../api'
import { Banner, Button, Card, Empty, Field, RevealOnce, Spinner, Status, relative } from '../ui'

export default function Webhooks({ tenantId }: { tenantId: string }) {
  const [payload, setPayload] = useState<{ events: string[]; data: WebhookEndpoint[] } | null>(null)
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [secret, setSecret] = useState<string | null>(null)
  const [ping, setPing] = useState<{ id: string; ok: boolean; status_code: number | null; latency_ms: number; error: string | null } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)

  const load = () => api.get<{ events: string[]; data: WebhookEndpoint[] }>(`/t/${tenantId}/webhooks`).then(setPayload)
  useEffect(() => { void load() }, [tenantId])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    const r = await api.post<{ secret: string }>(`/t/${tenantId}/webhooks`, { url, events })
    setSecret(r.secret)
    setUrl('')
    setEvents([])
    setAdding(false)
    await load()
  }

  async function remove(id: string) {
    if (!confirm('Delete this endpoint? Events will stop being delivered to it.')) return
    await api.del(`/t/${tenantId}/webhooks/${id}`)
    await load()
  }

  if (!payload) return <Spinner />

  return (
    <>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1>Webhooks</h1>
        <span style={{ marginLeft: 'auto' }} />
        <Button variant="primary" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : 'Add endpoint'}
        </Button>
      </div>

      {secret && (
        <Card title="Signing secret">
          <RevealOnce label="Signing secret" secret={secret} onDone={() => setSecret(null)} />
        </Card>
      )}

      <Card title="Verifying a delivery">
        <p className="muted" style={{ marginTop: 0 }}>
          Every request carries <code>X-Mail-Timestamp</code> and <code>X-Mail-Signature</code>.
          The signature is <code>HMAC-SHA256(secret, "&lt;timestamp&gt;.&lt;raw body&gt;")</code>,
          hex encoded. Compare it in constant time and reject anything with a timestamp
          more than a few minutes old.
        </p>
        <pre style={{ background: 'var(--bg-3)', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: '.8125rem', margin: 0 }}>
{`const expected = crypto
  .createHmac('sha256', secret)
  .update(\`\${req.headers['x-mail-timestamp']}.\${rawBody}\`)
  .digest('hex')

crypto.timingSafeEqual(
  Buffer.from(expected),
  Buffer.from(req.headers['x-mail-signature']),
)`}
        </pre>
      </Card>

      {adding && (
        <Card title="New endpoint">
          <form onSubmit={create}>
            <Field label="URL" hint="Must be HTTPS. We retry with backoff for about ten minutes.">
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourapp.com/hooks/mail" required />
            </Field>
            <Field label="Events">
              <div className="row">
                {payload.events.map((ev) => (
                  <label key={ev} className="row" style={{ gap: 6, fontSize: '.8125rem' }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={events.includes(ev)}
                      onChange={(e) =>
                        setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))
                      }
                    />
                    <code>{ev}</code>
                  </label>
                ))}
              </div>
            </Field>
            <Button type="submit" variant="primary" disabled={events.length === 0}>Create endpoint</Button>
          </form>
        </Card>
      )}

      {payload.data.length === 0 && !adding ? (
        <Card><Empty title="No webhook endpoints"><p>Add one to receive delivery and bounce events.</p></Empty></Card>
      ) : (
        payload.data.map((w) => (
          <Card
            key={w.id}
            title={w.url}
            action={
              <div className="row">
                <Status value={w.enabled ? (w.consecutiveFailures > 0 ? 'held' : 'delivered') : 'failed'} />
                <Button
                  className="btn-sm"
                  disabled={testing !== null}
                  onClick={async () => {
                    setTesting(w.id)
                    setPing(null)
                    try {
                      const r = await api.post<Omit<NonNullable<typeof ping>, 'id'>>(`/t/${tenantId}/webhooks/${w.id}/test`)
                      setPing({ id: w.id, ...r })
                      await load()
                    } catch (err) {
                      setPing({ id: w.id, ok: false, status_code: null, latency_ms: 0, error: err instanceof ApiError ? err.message : 'failed' })
                    } finally {
                      setTesting(null)
                    }
                  }}
                >
                  {testing === w.id ? 'Sending…' : 'Send test'}
                </Button>
                <Button variant="danger" className="btn-sm" onClick={() => remove(w.id)}>Delete</Button>
              </div>
            }
          >
            {ping?.id === w.id && (
              <Banner level={ping.ok ? 'info' : 'error'}>
                {ping.ok
                  ? `Your endpoint answered ${ping.status_code} in ${ping.latency_ms}ms. Signature verification is up to your handler — check its logs.`
                  : `Test failed: ${ping.error ?? `HTTP ${ping.status_code}`}. We retry real events with backoff; a test is a single attempt.`}
              </Banner>
            )}

            <div className="row" style={{ marginBottom: 12 }}>
              {w.events.map((e) => <code key={e} style={{ background: 'var(--bg-3)', padding: '2px 7px', borderRadius: 5 }}>{e}</code>)}
            </div>

            {w.consecutiveFailures > 0 && (
              <p style={{ color: 'var(--warn)' }}>
                {w.consecutiveFailures} consecutive failures. After 50 the endpoint is disabled automatically.
              </p>
            )}

            {w.deliveries && w.deliveries.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Event</th><th>Response</th><th>Latency</th><th>When</th></tr></thead>
                  <tbody>
                    {w.deliveries.map((d) => (
                      <tr key={d.id}>
                        <td className="mono">{d.event}</td>
                        <td className={d.statusCode && d.statusCode < 300 ? '' : 'muted'}>
                          {d.statusCode ?? 'no response'}
                        </td>
                        <td className="num">{d.latencyMs ? `${d.latencyMs}ms` : '—'}</td>
                        <td className="muted">{relative(d.createdAt)}</td>
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
