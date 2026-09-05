import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../api'
import { Banner, Button, Field, Spinner } from '../ui'

/**
 * The four single-use-token landing pages. They share a shell because they
 * share a failure mode -- an expired or spent link -- and the recovery from
 * that is the same in every case.
 */
type Mode = 'verify' | 'magic' | 'reset' | 'invite'

const COPY: Record<Mode, { title: string; blurb: string }> = {
  verify: { title: 'Confirming your email', blurb: '' },
  magic: { title: 'Signing you in', blurb: '' },
  reset: { title: 'Choose a new password', blurb: 'At least 12 characters. This signs out every other device.' },
  invite: { title: 'Accept your invitation', blurb: '' },
}

export default function Token({ mode, onDone }: { mode: Mode; onDone: () => Promise<void> }) {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<'working' | 'form' | 'done' | 'failed'>(
    mode === 'reset' ? 'form' : 'working',
  )
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [invite, setInvite] = useState<{ email: string; organization: string; role: string; has_account: boolean } | null>(null)

  useEffect(() => {
    if (mode === 'reset') return

    void (async () => {
      try {
        if (mode === 'invite') {
          const info = await api.get<typeof invite>(`/auth/invite/${token}`)
          setInvite(info)
          setState('form')
          return
        }
        await api.post(mode === 'verify' ? `/auth/verify/${token}` : `/auth/magic-link/${token}`)
        await onDone()
        setState('done')
        if (mode === 'magic') navigate('/', { replace: true })
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'That link could not be used')
        setState('failed')
      }
    })()
  }, [mode, token, onDone, navigate])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      if (mode === 'reset') {
        await api.post(`/auth/reset-password/${token}`, { password })
      } else {
        await api.post(`/auth/invite/${token}`, {
          name: name || undefined,
          password: invite?.has_account ? undefined : password,
        })
      }
      await onDone()
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <h1>{COPY[mode].title}</h1>
        {COPY[mode].blurb && <p>{COPY[mode].blurb}</p>}

        {state === 'working' && <Spinner />}

        {state === 'failed' && (
          <>
            <Banner level="error">{error}</Banner>
            <p style={{ fontSize: '.875rem' }}>
              Links can only be used once, and expire. Request a new one from the{' '}
              <Link to="/">sign-in page</Link>.
            </p>
          </>
        )}

        {state === 'done' && mode === 'verify' && (
          <>
            <Banner level="info">Your email address is confirmed.</Banner>
            <Button variant="primary" onClick={() => navigate('/')} style={{ width: '100%' }}>
              Continue to your dashboard
            </Button>
          </>
        )}

        {state === 'form' && (
          <form onSubmit={submit}>
            {error && <Banner level="error">{error}</Banner>}

            {mode === 'invite' && invite && (
              <p style={{ fontSize: '.875rem' }}>
                You have been invited to <strong>{invite.organization}</strong> as{' '}
                <strong>{invite.role.toLowerCase().replace(/_/g, ' ')}</strong>, using{' '}
                <code>{invite.email}</code>.
              </p>
            )}

            {mode === 'invite' && invite && !invite.has_account && (
              <Field label="Your name">
                <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </Field>
            )}

            {(mode === 'reset' || (invite && !invite.has_account)) && (
              <Field label={mode === 'reset' ? 'New password' : 'Choose a password'}>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={12}
                  required
                  autoComplete="new-password"
                />
              </Field>
            )}

            <Button type="submit" variant="primary" style={{ width: '100%' }}>
              {mode === 'reset' ? 'Set new password' : 'Accept and continue'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
