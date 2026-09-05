import { useState } from 'react'
import { api, ApiError } from '../api'
import { Banner, Button, Field } from '../ui'

export default function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ email: '', password: '', totp: '' })
  const [error, setError] = useState<{ message: string; code: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/login', form)
      await onDone()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { message: err.message, code: err.code }
          : { message: 'Sign in failed', code: 'unknown' },
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Mailkong Ops</h1>
        <p>Operator access. All actions are logged.</p>

        {error && (
          <Banner level="error">
            {error.message}
            {error.code === 'not_allowlisted' && (
              <div style={{ marginTop: 6, fontSize: '.8125rem' }}>
                You are not on an allowlisted network. Connect to the VPN and try again.
              </div>
            )}
          </Banner>
        )}

        <Field label="Email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoFocus autoComplete="username" />
        </Field>
        <Field label="Password">
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete="current-password" />
        </Field>
        <Field label="Two-factor code" hint="Required. Operator accounts cannot sign in without it.">
          <input
            value={form.totp}
            onChange={(e) => setForm({ ...form, totp: e.target.value.replace(/\D/g, '').slice(0, 6) })}
            inputMode="numeric"
            placeholder="000000"
            required
            autoComplete="one-time-code"
          />
        </Field>

        <Button type="submit" variant="primary" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
