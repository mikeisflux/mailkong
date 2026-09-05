import { useEffect, useState } from 'react'
import { api, type Credential } from '../api'
import { Button, Card, Copyable, Empty, Field, RevealOnce, Spinner, relative } from '../ui'

interface Payload {
  smtp: { host: string; port: number; security: string }
  data: Credential[]
}

export default function Credentials({ tenantId }: { tenantId: string }) {
  const [payload, setPayload] = useState<Payload | null>(null)
  const [creating, setCreating] = useState<'API_KEY' | 'SMTP' | null>(null)
  const [name, setName] = useState('')
  const [secret, setSecret] = useState<{ label: string; value: string; username?: string } | null>(null)

  const load = () => api.get<Payload>(`/t/${tenantId}/credentials`).then(setPayload)
  useEffect(() => { void load() }, [tenantId])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!creating) return
    const result = await api.post<{ secret: string; prefix: string }>(`/t/${tenantId}/credentials`, {
      kind: creating,
      name,
    })
    setSecret({
      label: creating === 'API_KEY' ? 'API key' : 'SMTP password',
      value: result.secret,
      username: creating === 'SMTP' ? result.prefix : undefined,
    })
    setName('')
    setCreating(null)
    await load()
  }

  async function revoke(c: Credential) {
    if (!confirm(`Revoke "${c.name}"? Anything using it will stop sending immediately.`)) return
    await api.del(`/t/${tenantId}/credentials/${c.id}`)
    await load()
  }

  if (!payload) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Credentials</h1>

      {secret && (
        <Card title={`Your new ${secret.label.toLowerCase()}`}>
          {secret.username && (
            <Field label="SMTP username">
              <Copyable value={secret.username} />
            </Field>
          )}
          <RevealOnce label={secret.label} secret={secret.value} onDone={() => setSecret(null)} />
        </Card>
      )}

      <Card title="SMTP settings">
        <div className="grid grid-3">
          <Field label="Host"><Copyable value={payload.smtp.host} /></Field>
          <Field label="Port"><Copyable value={String(payload.smtp.port)} /></Field>
          <Field label="Security"><Copyable value={payload.smtp.security} /></Field>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Use an SMTP credential below as the username and password. Port 587 with
          STARTTLS — do not use port 25 for submission.
        </p>
      </Card>

      <Card
        title="Keys and SMTP users"
        action={
          <div className="row">
            <Button className="btn-sm" onClick={() => setCreating(creating === 'API_KEY' ? null : 'API_KEY')}>
              New API key
            </Button>
            <Button className="btn-sm" onClick={() => setCreating(creating === 'SMTP' ? null : 'SMTP')}>
              New SMTP user
            </Button>
          </div>
        }
      >
        {creating && (
          <form onSubmit={create} style={{ marginBottom: 18 }}>
            <Field
              label={creating === 'API_KEY' ? 'Name this key' : 'Name this SMTP user'}
              hint="Something you will recognise later — the app or environment it belongs to."
            >
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="production-api" required autoFocus />
            </Field>
            <Button type="submit" variant="primary">Create</Button>
          </form>
        )}

        {payload.data.length === 0 ? (
          <Empty title="No credentials yet">
            <p>Create an API key to send over HTTP, or an SMTP user for an existing app.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Type</th><th>Identifier</th><th>Last used</th><th /></tr>
              </thead>
              <tbody>
                {payload.data.map((c) => (
                  <tr key={c.id}>
                    <td style={{ color: 'var(--ink)', fontWeight: 550 }}>{c.name}</td>
                    <td>{c.kind === 'API_KEY' ? 'API key' : 'SMTP'}</td>
                    <td className="mono">{c.prefix}…</td>
                    <td className="muted">{c.lastUsedAt ? relative(c.lastUsedAt) : 'never'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Button variant="danger" className="btn-sm" onClick={() => revoke(c)}>Revoke</Button>
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
