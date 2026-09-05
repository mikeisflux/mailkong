import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../api'
import { Banner, Button, Field } from '../ui'

export default function Signup({ onDone }: { onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ name: '', organization: '', email: '', password: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/signup', form)
      await onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the account')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Create your account</h1>
        <p>You will verify a sending domain before any mail goes out.</p>

        {error && <Banner level="error">{error}</Banner>}

        <Field label="Your name">
          <input value={form.name} onChange={set('name')} required autoFocus />
        </Field>
        <Field label="Organization" hint="Shown on invoices, and used to name your mail server.">
          <input value={form.organization} onChange={set('organization')} required />
        </Field>
        <Field label="Work email">
          <input type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
        </Field>
        <Field label="Password" hint="At least 12 characters.">
          <input type="password" value={form.password} onChange={set('password')} required minLength={12} autoComplete="new-password" />
        </Field>

        <Button type="submit" variant="primary" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>

        <p style={{ marginTop: 18, marginBottom: 0, textAlign: 'center', fontSize: '.875rem' }}>
          Already have one? <Link to="/">Sign in</Link>
        </p>
      </form>
    </div>
  )
}
