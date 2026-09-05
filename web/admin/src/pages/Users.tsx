import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type Operator } from '../api'
import { Banner, Button, Card, Empty, Field, Spinner, Status, relative } from '../ui'

interface UserRow {
  id: string
  email: string
  name: string | null
  email_verified: boolean
  created_at: string
  active_sessions: number
  memberships: Array<{ id: string; role: string; tenant: { id: string; name: string; slug: string; status: string } }>
}

interface UserDetail {
  user: UserRow & {
    has_password: boolean
    sessions: Array<{ id: string; ip: string | null; user_agent: string | null; impersonated: boolean; created_at: string }>
  }
  recent_actions: Array<{ id: string; action: string; createdAt: string }>
}

export default function Users({ me }: { me: Operator }) {
  const [rows, setRows] = useState<UserRow[] | null>(null)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<UserDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const canWrite = ['SUPERADMIN', 'SUPPORT'].includes(me.role)
  const canDelete = me.role === 'SUPERADMIN'

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    setRows((await api.get<{ data: UserRow[] }>(`/users?${params}`)).data)
  }, [search])

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, search])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await load()
      if (open) setOpen(await api.get<UserDetail>(`/users/${open.user.id}`))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed')
    }
  }

  return (
    <>
      <h1 style={{ marginBottom: 6 }}>Users</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Every person with a dashboard login, across all tenants.
      </p>

      {error && <Banner level="error">{error}</Banner>}
      {notice && <Banner level="info">{notice}</Banner>}

      <Card>
        <input
          placeholder="Search by email or name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 380 }}
        />
      </Card>

      {open && (
        <Card
          title={open.user.email}
          action={<Button className="btn-sm" onClick={() => setOpen(null)}>Close</Button>}
        >
          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            <div>
              <Field label="Name">
                <input
                  defaultValue={open.user.name ?? ''}
                  disabled={!canWrite}
                  onBlur={(e) =>
                    e.target.value !== (open.user.name ?? '') &&
                    act(() => api.patch(`/users/${open.user.id}`, { name: e.target.value || null }))
                  }
                />
              </Field>
              <Field label="Email" hint="Changing this clears their verified status.">
                <input
                  defaultValue={open.user.email}
                  disabled={!canWrite}
                  onBlur={(e) =>
                    e.target.value !== open.user.email &&
                    act(() => api.patch(`/users/${open.user.id}`, { email: e.target.value }))
                  }
                />
              </Field>
            </div>
            <div>
              <table>
                <tbody>
                  <tr><td>Email verified</td><td>{open.user.email_verified ? 'yes' : 'no'}</td></tr>
                  <tr><td>Has a password</td><td>{open.user.has_password ? 'yes' : 'magic link only'}</td></tr>
                  <tr><td>Active sessions</td><td className="num">{open.user.active_sessions}</td></tr>
                  <tr><td>Created</td><td>{new Date(open.user.created_at).toLocaleDateString()}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="row" style={{ marginBottom: 16 }}>
            <Button
              disabled={!canWrite}
              onClick={() =>
                act(async () => {
                  const r = await api.post<{ delivered: boolean; manual_link: string | null }>(
                    `/users/${open.user.id}/send-reset`,
                  )
                  setNotice(
                    r.delivered
                      ? `Reset link emailed to ${open.user.email}.`
                      : `Platform email is not sending yet. Give them this link: ${r.manual_link}`,
                  )
                })
              }
            >
              Send password reset
            </Button>

            <Button
              disabled={!canWrite || open.user.active_sessions === 0}
              onClick={() => act(() => api.post(`/users/${open.user.id}/revoke-sessions`))}
            >
              Revoke {open.user.active_sessions} session{open.user.active_sessions === 1 ? '' : 's'}
            </Button>

            {!open.user.email_verified && (
              <Button
                disabled={!canWrite}
                onClick={() => act(() => api.patch(`/users/${open.user.id}`, { email_verified: true }))}
              >
                Mark email verified
              </Button>
            )}

            <Button
              variant="danger"
              disabled={!canDelete}
              onClick={() => {
                if (!confirm(`Delete ${open.user.email}? This cannot be undone.`)) return
                void act(async () => {
                  await api.del(`/users/${open.user.id}`)
                  setOpen(null)
                })
              }}
            >
              Delete user
            </Button>
          </div>

          <h3 style={{ marginBottom: 8 }}>Organizations</h3>
          {open.user.memberships.length === 0 ? (
            <Empty title="Not a member of any organization" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Organization</th><th>Status</th><th>Role</th><th /></tr></thead>
                <tbody>
                  {open.user.memberships.map((m) => (
                    <tr key={m.id}>
                      <td><Link to={`/tenants/${m.tenant.id}`}>{m.tenant.name}</Link></td>
                      <td><Status value={m.tenant.status} /></td>
                      <td>
                        <select
                          defaultValue={m.role}
                          disabled={!canWrite}
                          onChange={(e) =>
                            act(() =>
                              api.patch(`/users/${open.user.id}/memberships/${m.id}`, { role: e.target.value }),
                            )
                          }
                          style={{ maxWidth: 150 }}
                        >
                          <option value="OWNER">Owner</option>
                          <option value="ADMIN">Admin</option>
                          <option value="DEVELOPER">Developer</option>
                          <option value="READ_ONLY">Read only</option>
                        </select>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Button
                          variant="danger"
                          className="btn-sm"
                          disabled={!canWrite}
                          onClick={() => act(() => api.del(`/users/${open.user.id}/memberships/${m.id}`))}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {open.user.sessions.length > 0 && (
            <>
              <h3 style={{ margin: '20px 0 8px' }}>Active sessions</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Started</th><th>IP</th><th>Client</th><th /></tr></thead>
                  <tbody>
                    {open.user.sessions.map((s) => (
                      <tr key={s.id}>
                        <td className="muted">{relative(s.created_at)}</td>
                        <td className="mono">{s.ip ?? '—'}</td>
                        <td className="muted" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {s.user_agent ?? '—'}
                        </td>
                        <td>{s.impersonated && <span style={{ color: 'var(--warn)', fontWeight: 600 }}>impersonated</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? (
          <Empty title="No users match" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Email</th><th>Name</th><th>Organizations</th><th>Verified</th><th>Sessions</th><th>Joined</th></tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr
                    key={u.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => void api.get<UserDetail>(`/users/${u.id}`).then(setOpen)}
                  >
                    <td className="mono" style={{ color: 'var(--ink)' }}>{u.email}</td>
                    <td>{u.name ?? <span className="muted">—</span>}</td>
                    <td>
                      {u.memberships.length === 0
                        ? <span className="muted">none</span>
                        : u.memberships.map((m) => m.tenant.name).join(', ')}
                    </td>
                    <td>{u.email_verified ? 'yes' : <span className="muted">no</span>}</td>
                    <td className="num">{u.active_sessions}</td>
                    <td className="muted">{new Date(u.created_at).toLocaleDateString()}</td>
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
