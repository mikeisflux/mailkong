import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Banner, Button, Field } from '../ui'

export default function Forgot({ mode }: { mode: 'reset' | 'magic' }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    await api.post(mode === 'reset' ? '/auth/forgot-password' : '/auth/magic-link', { email })
    // Always the same outcome: this page must not reveal who has an account.
    setSent(true)
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>{mode === 'reset' ? 'Reset your password' : 'Sign in with a link'}</h1>
        <p>
          {mode === 'reset'
            ? 'We will email you a link to choose a new one.'
            : 'We will email you a link that signs you in, no password needed.'}
        </p>

        {sent ? (
          <>
            <Banner level="info">
              If <strong>{email}</strong> has an account, a link is on its way. It expires
              in {mode === 'reset' ? 'one hour' : '15 minutes'}.
            </Banner>
            <p style={{ fontSize: '.875rem', textAlign: 'center', marginBottom: 0 }}>
              <Link to="/">Back to sign in</Link>
            </p>
          </>
        ) : (
          <>
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" />
            </Field>
            <Button type="submit" variant="primary" style={{ width: '100%' }}>
              Send link
            </Button>
            <p style={{ marginTop: 18, marginBottom: 0, textAlign: 'center', fontSize: '.875rem' }}>
              <Link to="/">Back to sign in</Link>
            </p>
          </>
        )}
      </form>
    </div>
  )
}
