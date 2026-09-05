import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { Banner, Button, Card, Empty, Field, Spinner } from '../ui'

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

  const load = () => api.get<{ data: Route[] }>(`/t/${tenantId}/inbound`).then((r) => setRoutes(r.data)).catch(() => setRoutes([]))
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

      <Card>
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
    </>
  )
}
