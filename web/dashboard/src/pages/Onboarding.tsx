import { useState } from 'react'
import { api, ApiError, type DnsRecord, type Domain } from '../api'
import { Banner, Button, Card, Check, Copyable, Field, RevealOnce } from '../ui'

/**
 * Forced until the first domain verifies (spec 8.2). The DNS step polls
 * rather than making the user hit refresh, because the wait is the part of
 * onboarding people give up during.
 */
export default function Onboarding({ tenantId, onVerified }: { tenantId: string; onVerified: () => Promise<void> }) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [domain, setDomain] = useState('')
  const [created, setCreated] = useState<{ domain: Domain; records: DnsRecord[] } | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState<string | null>(null)

  async function addDomain(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const result = await api.post<{ domain: Domain; records: DnsRecord[] }>(
        `/t/${tenantId}/domains`,
        { name: domain, kind: 'SENDING' },
      )
      setCreated(result)
      setStep(2)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that domain')
    }
  }

  async function check() {
    if (!created) return
    setChecking(true)
    setError(null)
    try {
      const updated = await api.post<Domain>(`/t/${tenantId}/domains/${created.domain.id}/check`)
      setCreated({ ...created, domain: updated })
      if (updated.verifiedAt) setStep(3)
      else setError('Not resolving yet. DNS can take a few minutes to propagate — try again shortly.')
    } finally {
      setChecking(false)
    }
  }

  async function createKey() {
    const result = await api.post<{ secret: string }>(`/t/${tenantId}/credentials`, {
      kind: 'API_KEY',
      name: 'First key',
    })
    setKey(result.secret)
  }

  return (
    <>
      <h1 style={{ marginBottom: 6 }}>Set up sending</h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: 22 }}>
        Three steps. Your account activates the moment a domain passes SPF and DKIM.
      </p>

      <div className="steps-bar">
        <i className={step >= 1 ? 'done' : ''} />
        <i className={step >= 2 ? 'done' : ''} />
        <i className={step >= 3 ? 'done' : ''} />
      </div>

      {error && <Banner level={step === 2 ? 'warning' : 'error'}>{error}</Banner>}

      {step === 1 && (
        <Card title="1. Add a sending domain">
          <form onSubmit={addDomain}>
            <Field
              label="Domain"
              hint="The domain your mail will come from — for example yourshop.com, not mail.yourshop.com."
            >
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="yourshop.com"
                required
                autoFocus
              />
            </Field>
            <Button type="submit" variant="primary">Add domain</Button>
          </form>
        </Card>
      )}

      {step === 2 && created && (
        <Card
          title={`2. Publish these records for ${created.domain.name}`}
          action={
            <Button variant="primary" onClick={check} disabled={checking}>
              {checking ? 'Checking…' : 'Check DNS'}
            </Button>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>
            Add these at your DNS provider. SPF and DKIM are required; DMARC and the
            return path are recommended and can follow later.
          </p>

          <div className="row" style={{ marginBottom: 14 }}>
            <Check ok={created.domain.spfOk} label="SPF" />
            <Check ok={created.domain.dkimOk} label="DKIM" />
            <Check ok={created.domain.dmarcOk} label="DMARC" />
            <Check ok={created.domain.returnPathOk} label="Return path" />
          </div>

          <div className="table-wrap">
            <table className="dns-table">
              <thead>
                <tr><th>Type</th><th>Name</th><th>Value</th><th>Required</th></tr>
              </thead>
              <tbody>
                {created.records.map((r) => (
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

          {created.domain.lastCheckOutput && (
            <Banner level="warning">
              <strong>Last check said:</strong> {created.domain.lastCheckOutput}
            </Banner>
          )}
        </Card>
      )}

      {step === 3 && (
        <Card title="3. Create your first API key">
          <Banner level="info">
            {created?.domain.name} is verified. Your account is active and can send.
          </Banner>

          {key ? (
            <RevealOnce
              label="API key"
              secret={key}
              onDone={() => void onVerified()}
            />
          ) : (
            <>
              <p className="muted">
                One key to start with. You can create more, and revoke this one, at any time.
              </p>
              <Button variant="primary" onClick={createKey}>Create API key</Button>
            </>
          )}
        </Card>
      )}
    </>
  )
}
