import { useEffect, useState } from 'react'
import { api, ApiError, type DnsRecord, type Domain } from '../api'
import { Banner, Button, Card, Check, Copyable, Empty, Field, Spinner, relative } from '../ui'

export default function Domains({ tenantId }: { tenantId: string }) {
  const [domains, setDomains] = useState<Domain[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [checking, setChecking] = useState<string | null>(null)

  const load = () => api.get<{ data: Domain[] }>(`/t/${tenantId}/domains`).then((r) => setDomains(r.data))
  useEffect(() => { void load() }, [tenantId])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await api.post(`/t/${tenantId}/domains`, { name, kind: 'SENDING' })
      setName('')
      setAdding(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that domain')
    }
  }

  async function check(id: string) {
    setChecking(id)
    try {
      await api.post(`/t/${tenantId}/domains/${id}/check`)
      await load()
    } finally {
      setChecking(null)
    }
  }

  async function remove(d: Domain) {
    if (!confirm(`Remove ${d.name}? Mail can no longer be sent from this domain.`)) return
    try {
      await api.del(`/t/${tenantId}/domains/${d.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that domain')
    }
  }

  if (!domains) return <Spinner />

  return (
    <>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1>Domains</h1>
        <span className="spacer" style={{ marginLeft: 'auto' }} />
        <Button variant="primary" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : 'Add domain'}
        </Button>
      </div>

      {error && <Banner level="error">{error}</Banner>}

      {adding && (
        <Card title="Add a sending domain">
          <form onSubmit={add}>
            <Field label="Domain" hint="Publish the DNS records we generate, then check.">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="yourshop.com" required autoFocus />
            </Field>
            <Button type="submit" variant="primary">Add</Button>
          </form>
        </Card>
      )}

      {domains.length === 0 && !adding && (
        <Card><Empty title="No domains yet"><p>Add one to start sending.</p></Empty></Card>
      )}

      {domains.map((d) => {
        const records = (d.dnsRecords ?? []) as DnsRecord[]
        const expanded = open === d.id
        return (
          <Card
            key={d.id}
            title={d.name}
            action={
              <div className="row">
                <Check ok={d.spfOk} label="SPF" />
                <Check ok={d.dkimOk} label="DKIM" />
                <Check ok={d.dmarcOk} label="DMARC" />
                <Button className="btn-sm" onClick={() => setOpen(expanded ? null : d.id)}>
                  {expanded ? 'Hide records' : 'Records'}
                </Button>
                <Button className="btn-sm" onClick={() => check(d.id)} disabled={checking === d.id}>
                  {checking === d.id ? 'Checking…' : 'Recheck'}
                </Button>
                <Button variant="danger" className="btn-sm" onClick={() => remove(d)}>Remove</Button>
              </div>
            }
          >
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">
                {d.verifiedAt
                  ? `Verified. Mail can be sent from ${d.name}.`
                  : 'Not verified yet — SPF and DKIM must both pass before this domain can send.'}
              </span>
              <span className="muted">
                {d.lastCheckedAt ? `Checked ${relative(d.lastCheckedAt)}` : 'Never checked'}
              </span>
            </div>

            {d.lastCheckOutput && !d.verifiedAt && (
              <Banner level="warning">{d.lastCheckOutput}</Banner>
            )}

            {expanded && (
              <>
              <div className="grid grid-2" style={{ marginTop: 14 }}>
                <label className="row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    defaultChecked={d.trackingEnabled}
                    onChange={(e) =>
                      void api.patch(`/t/${tenantId}/domains/${d.id}`, { tracking_enabled: e.target.checked }).then(load)
                    }
                  />
                  <span>
                    Track opens and clicks
                    <div className="muted" style={{ fontSize: '.75rem' }}>
                      Rewrites links and adds a tracking pixel. Off by default — your privacy
                      notice should mention it if you turn it on.
                    </div>
                  </span>
                </label>
                <Field label="Default From address" hint={`Must be at @${d.name}. Prefilled on the test send screen.`}>
                  <input
                    defaultValue={d.defaultFrom ?? ''}
                    placeholder={`no-reply@${d.name}`}
                    onBlur={(e) =>
                      e.target.value !== (d.defaultFrom ?? '') &&
                      void api
                        .patch(`/t/${tenantId}/domains/${d.id}`, { default_from: e.target.value || null })
                        .then(load)
                        .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not save'))
                    }
                  />
                </Field>
              </div>
              </>
            )}

            {expanded && (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table className="dns-table">
                  <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Required</th></tr></thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={`${r.type}-${r.name}`}>
                        <td className="mono">{r.type}</td>
                        <td><Copyable value={r.name} /></td>
                        <td><Copyable value={r.value} /></td>
                        <td>{r.required ? 'Yes' : 'Recommended'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )
      })}
    </>
  )
}
