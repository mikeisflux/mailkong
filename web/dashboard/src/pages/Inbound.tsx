import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { Banner, Button, Card, Empty, Field, Spinner, relative } from '../ui'

interface InboundMessage {
  id: string
  from: string
  to: string
  subject: string | null
  spamScore: number | null
  preview: string | null
  createdAt: string
  route: { address: string; domain: string }
}

interface Route {
  id: string
  address: string
  domain: string
  endpointUrl: string
  enabled: boolean
  createdAt: string
}

export default function Inbound({ tenantId }: { tenantId: string }) {
  const [routes, setRoutes] = useState<Route[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ address: 'support', domain: '', endpoint_url: '' })
  const [error, setError] = useState<string | null>(null)

  const [messages, setMessages] = useState<InboundMessage[]>([])

  const load = async () => {
    await api.get<{ data: Route[] }>(`/t/${tenantId}/inbound`).then((r) => setRoutes(r.data)).catch(() => setRoutes([]))
    await api
      .get<{ data: InboundMessage[] }>(`/t/${tenantId}/inbound/messages`)
      .then((r) => setMessages(r.data))
      .catch(() => setMessages([]))
  }
  useEffect(() => { void load() }, [tenantId])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await api.post(`/t/${tenantId}/inbound`, form)
      setAdding(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the route')
    }
  }

  if (!routes) return <Spinner />

  return (
    <>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1>Inbound</h1>
        <span style={{ marginLeft: 'auto' }} />
        <Button variant="primary" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : 'Add route'}
        </Button>
      </div>

      {error && <Banner level="error">{error}</Banner>}

      <Card title="How inbound works">
        <p className="muted" style={{ margin: 0 }}>
          Point an MX record at <code>routes.mailkong.net</code> for the subdomain you want
          to receive on — usually <code>inbound.yourdomain.com</code>. Mail arriving at a
          matching address is parsed and POSTed to your endpoint as JSON, signed the same
          way as delivery webhooks.
        </p>
      </Card>

      {adding && (
        <Card title="New inbound route">
          <form onSubmit={create}>
            <Field label="Address" hint="The local part before the @, or * for a catch-all.">
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
            </Field>
            <Field label="Domain" hint="The domain whose MX points at us.">
              <input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="inbound.yourshop.com" required />
            </Field>
            <Field label="Destination webhook">
              <input type="url" value={form.endpoint_url} onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })} placeholder="https://yourapp.com/hooks/inbound" required />
            </Field>
            <Button type="submit" variant="primary">Create route</Button>
          </form>
        </Card>
      )}

      <Card title="Routes">
        {routes.length === 0 ? (
          <Empty title="No inbound routes"><p>Route replies to a webhook instead of a mailbox nobody reads.</p></Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>Destination</th><th>Status</th></tr></thead>
              <tbody>
                {routes.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.address}@{r.domain}</td>
                    <td className="mono">{r.endpointUrl}</td>
                    <td>{r.enabled ? 'Active' : 'Disabled'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Recent inbound">
        <p className="muted" style={{ marginTop: 0 }}>
          What arrived, whether or not your endpoint accepted it. Bodies are not stored here —
          the full message went to your webhook.
        </p>
        {messages.length === 0 ? (
          <Empty title="Nothing received yet">
            <p>Once your MX record resolves, mail arriving on a route appears here.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Route</th><th>From</th><th>Subject</th><th>Spam</th></tr></thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <td className="muted">{relative(m.createdAt)}</td>
                    <td className="mono">{m.route.address}@{m.route.domain}</td>
                    <td className="mono">{m.from}</td>
                    <td>
                      {m.subject ?? <span className="muted">(no subject)</span>}
                      {m.preview && (
                        <div className="muted" style={{ fontSize: '.75rem', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.preview}
                        </div>
                      )}
                    </td>
                    <td className="num">{m.spamScore?.toFixed(1) ?? '—'}</td>
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
