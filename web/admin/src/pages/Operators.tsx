import { useEffect, useState } from 'react'
import { api, ApiError, type Operator } from '../api'
import { Banner, Button, Card, Empty, Field, RevealOnce, Spinner, relative } from '../ui'

interface Row {
  id: string
  email: string
  name: string | null
  role: string
  totp_enabled: boolean
  disabled: boolean
  last_login_at: string | null
  active_sessions: number
  actions_logged: number
  created_at: string
}

const ROLE_HELP: Record<string, string> = {
  SUPERADMIN: 'Everything, including IP pools, plans, system flags and other operators.',
  SUPPORT: 'Pause, impersonate, read messages, work the abuse queue, help customers with sign-in.',
  BILLING: 'Plans and refunds. Cannot read customer messages or pause accounts.',
  READ_ONLY: 'Read messages and customer accounts. Changes nothing.',
}

export default function Operators({ me }: { me: Operator }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ email: '', name: '', role: 'SUPPORT' })
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changingPassword, setChangingPassword] = useState(false)
  const [pw, setPw] = useState({ current: '', next: '' })

  const canWrite = me.role === 'SUPERADMIN'
  const load = () => api.get<{ data: Row[] }>('/operators').then((r) => setRows(r.data))
  useEffect(() => { void load() }, [])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed')
    }
  }

  if (!rows) return <Spinner />

  const activeSuperadmins = rows.filter((r) => r.role === 'SUPERADMIN' && !r.disabled).length

  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <h1>Operators</h1>
        <span style={{ marginLeft: 'auto' }} />
        {canWrite && (
          <Button variant="primary" onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add operator'}
          </Button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        People who can sign in to this console. Every action any of them takes is in the audit log.
      </p>

      {error && <Banner level="error">{error}</Banner>}
      {!canWrite && <Banner level="info">Only a superadmin can add or change operators.</Banner>}
      {activeSuperadmins === 1 && (
        <Banner level="warning">
          There is only one active superadmin. If that account loses its authenticator, nobody can
          administer this console. Add a second one.
        </Banner>
      )}

      {secret && (
        <Card title="Temporary password">
          <RevealOnce label={secret.label} secret={secret.value} onDone={() => setSecret(null)} />
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Send this out of band, not by email. They cannot sign in until they enrol two-factor
            authentication, so this password alone is not access.
          </p>
        </Card>
      )}

      {adding && (
        <Card title="New operator">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void act(async () => {
                const r = await api.post<{ temporary_password: string }>('/operators', form)
                setSecret({ label: `Temporary password for ${form.email}`, value: r.temporary_password })
                setForm({ email: '', name: '', role: 'SUPPORT' })
                setAdding(false)
              })
            }}
          >
            <div className="grid grid-3">
              <Field label="Email">
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoFocus />
              </Field>
              <Field label="Name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field label="Role">
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="SUPERADMIN">Superadmin</option>
                  <option value="SUPPORT">Support</option>
                  <option value="BILLING">Billing</option>
                  <option value="READ_ONLY">Read only</option>
                </select>
              </Field>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>{ROLE_HELP[form.role]}</p>
            <Button type="submit" variant="primary">Create operator</Button>
          </form>
        </Card>
      )}

      <Card>
        {rows.length === 0 ? <Empty title="No operators" /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Operator</th><th>Role</th><th>2FA</th><th>Last sign-in</th><th>Actions logged</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const isSelf = o.id === me.id
                  const lastSuper = o.role === 'SUPERADMIN' && !o.disabled && activeSuperadmins <= 1
                  return (
                    <tr key={o.id} style={o.disabled ? { opacity: 0.55 } : undefined}>
                      <td>
                        <strong style={{ color: 'var(--ink)' }}>{o.name ?? o.email}</strong>
                        {isSelf && <span className="muted"> · you</span>}
                        <div className="muted mono" style={{ fontSize: '.75rem' }}>{o.email}</div>
                        {o.disabled && <div style={{ color: 'var(--err)', fontSize: '.75rem', fontWeight: 600 }}>disabled</div>}
                      </td>
                      <td>
                        <select
                          defaultValue={o.role}
                          disabled={!canWrite || isSelf || lastSuper}
                          onChange={(e) => act(() => api.patch(`/operators/${o.id}`, { role: e.target.value }))}
                          style={{ maxWidth: 150 }}
                        >
                          <option value="SUPERADMIN">Superadmin</option>
                          <option value="SUPPORT">Support</option>
                          <option value="BILLING">Billing</option>
                          <option value="READ_ONLY">Read only</option>
                        </select>
                        <div className="muted" style={{ fontSize: '.75rem', marginTop: 2, maxWidth: 260 }}>
                          {ROLE_HELP[o.role]}
                        </div>
                      </td>
                      <td>
                        {o.totp_enabled
                          ? <span style={{ color: 'var(--ok)', fontWeight: 600 }}>enrolled</span>
                          : <span style={{ color: 'var(--warn)', fontWeight: 600 }}>not enrolled</span>}
                      </td>
                      <td className="muted">{o.last_login_at ? relative(o.last_login_at) : 'never'}</td>
                      <td className="num">{o.actions_logged.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          {canWrite && o.totp_enabled && (
                            <Button
                              className="btn-sm"
                              onClick={() => {
                                if (!confirm(`Clear 2FA for ${o.email}? They will re-enrol on next sign-in.`)) return
                                void act(() => api.post(`/operators/${o.id}/reset-totp`))
                              }}
                            >
                              Reset 2FA
                            </Button>
                          )}
                          {canWrite && (
                            <Button
                              className="btn-sm"
                              onClick={() =>
                                act(async () => {
                                  const r = await api.post<{ temporary_password: string }>(
                                    `/operators/${o.id}/reset-password`,
                                  )
                                  setSecret({ label: `New temporary password for ${o.email}`, value: r.temporary_password })
                                })
                              }
                            >
                              Reset password
                            </Button>
                          )}
                          {canWrite && !isSelf && !lastSuper && (
                            <Button
                              className="btn-sm"
                              variant={o.disabled ? 'ghost' : 'danger'}
                              onClick={() => act(() => api.patch(`/operators/${o.id}`, { disabled: !o.disabled }))}
                            >
                              {o.disabled ? 'Enable' : 'Disable'}
                            </Button>
                          )}
                          {canWrite && !isSelf && !lastSuper && (
                            <Button
                              className="btn-sm"
                              variant="danger"
                              onClick={() => {
                                if (!confirm(`Delete ${o.email}? Their audit history is kept.`)) return
                                void act(() => api.del(`/operators/${o.id}`))
                              }}
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Your password"
        action={<Button className="btn-sm" onClick={() => setChangingPassword(!changingPassword)}>
          {changingPassword ? 'Cancel' : 'Change'}
        </Button>}
      >
        {changingPassword ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void act(async () => {
                await api.post('/operators/me/password', pw)
                setPw({ current: '', next: '' })
                setChangingPassword(false)
              })
            }}
          >
            <div className="grid grid-2">
              <Field label="Current password">
                <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required autoComplete="current-password" />
              </Field>
              <Field label="New password" hint="At least 12 characters.">
                <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} minLength={12} required autoComplete="new-password" />
              </Field>
            </div>
            <Button type="submit" variant="primary">Change password</Button>
          </form>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Signed in as <code>{me.email}</code>. Changing your password does not end your current session.
          </p>
        )}
      </Card>
    </>
  )
}
