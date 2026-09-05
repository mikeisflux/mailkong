import { useEffect, useState } from 'react'
import { api, ApiError, type Domain } from '../api'
import { Banner, Button, Card, Field, Spinner } from '../ui'

/**
 * Goes through the same path as the public API (spec 8.2), so what a
 * customer debugs here is the real stack, not a shortcut around it.
 */
export default function TestSend({ tenantId }: { tenantId: string }) {
  const [domains, setDomains] = useState<Domain[] | null>(null)
  const [form, setForm] = useState({ local: 'hello', domain: '', to: '', subject: 'Test from Mailkong', html: '<p>It works.</p>' })
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<{ message: string; code: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.get<{ data: Domain[] }>(`/t/${tenantId}/domains`).then((r) => {
      const verified = r.data.filter((d) => d.verifiedAt)
      setDomains(verified)
      if (verified[0]) setForm((f) => ({ ...f, domain: verified[0]!.name }))
    })
  }, [tenantId])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const r = await api.post<{ id: string }>(`/t/${tenantId}/test-send`, {
        from: `${form.local}@${form.domain}`,
        to: form.to,
        subject: form.subject,
        html: form.html,
      })
      setResult(r.id)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { message: err.message, code: err.code }
          : { message: 'Send failed', code: 'unknown' },
      )
    } finally {
      setBusy(false)
    }
  }

  if (!domains) return <Spinner />

  if (domains.length === 0) {
    return (
      <>
        <h1 style={{ marginBottom: 20 }}>Test send</h1>
        <Card>
          <Banner level="warning">
            You need a verified sending domain first. Publish its SPF and DKIM records,
            then come back.
          </Banner>
        </Card>
      </>
    )
  }

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Test send</h1>

      {result && (
        <Banner level="info">
          Queued as <code>{result}</code>. Watch it in Activity for the delivery result.
        </Banner>
      )}
      {error && (
        <Banner level="error">
          {error.message} <span className="muted">({error.code})</span>
        </Banner>
      )}

      <Card title="Send a message">
        <form onSubmit={send}>
          <Field label="From" hint="Only verified domains can appear here.">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                value={form.local}
                onChange={(e) => setForm({ ...form, local: e.target.value })}
                style={{ maxWidth: 180 }}
                required
              />
              <span className="muted">@</span>
              <select value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })}>
                {domains.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </div>
          </Field>

          <Field label="To">
            <input type="email" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} required placeholder="you@example.com" />
          </Field>

          <Field label="Subject">
            <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required />
          </Field>

          <Field label="HTML body">
            <textarea value={form.html} onChange={(e) => setForm({ ...form, html: e.target.value })} />
          </Field>

          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send test message'}
          </Button>
        </form>
      </Card>
    </>
  )
}
