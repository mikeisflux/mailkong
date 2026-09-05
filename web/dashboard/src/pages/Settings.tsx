import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { Banner, Button, Card, Copyable, Empty, Field, Spinner } from '../ui'

interface TeamPayload {
  members: Array<{ id: string; role: string; user: { id: string; email: string; name: string | null } }>
  invites: Array<{ id: string; email: string; role: string; expiresAt: string }>
}

interface SsoPayload {
  configured: boolean
  connection: {
    issuer: string
    client_id: string
    domains: string[]
    enforced: boolean
    enabled: boolean
    default_role: string
    discovered_at: string | null
  } | null
  redirect_uri: string
  login_url: string
}

interface DedicatedIpPayload {
  request: { status: string; created_at: string } | null
  assigned: { pool: string; addresses: Array<{ address: string; ptr: string | null; warming: boolean; daily_cap: number | null }> } | null
}

interface SettingsPayload {
  name: string
  slug: string
  timezone: string
  status: string
  your_role: string
  notifications: {
    emails: string[]
    bounceSpike: boolean
    capWarning: boolean
    webhookDown: boolean
    invoiceFailed: boolean
  } | null
}

const ROLE_HELP: Record<string, string> = {
  OWNER: 'Everything, including billing and closing the account.',
  ADMIN: 'Everything except billing.',
  DEVELOPER: 'Send, manage domains and credentials. No team or billing access.',
  READ_ONLY: 'View activity and domains. Cannot send.',
}

const ALERTS = [
  ['bounceSpike', 'Sending paused, or a domain broke'],
  ['capWarning', 'Approaching the monthly limit'],
  ['webhookDown', 'A webhook endpoint is failing'],
  ['invoiceFailed', 'A payment failed'],
] as const

export default function Settings({ tenantId, role }: { tenantId: string; role: string }) {
  const [team, setTeam] = useState<TeamPayload | null>(null)
  const [settings, setSettings] = useState<SettingsPayload | null>(null)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('DEVELOPER')
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const upper = role.toUpperCase()
  const canManageTeam = upper === 'OWNER' || upper === 'ADMIN'
  const isOwner = upper === 'OWNER'

  const [sso, setSso] = useState<SsoPayload | null>(null)
  const [ssoForm, setSsoForm] = useState({ issuer: '', client_id: '', client_secret: '', domains: '', enforced: false, default_role: 'READ_ONLY' })
  const [editingSso, setEditingSso] = useState(false)
  const [dedicated, setDedicated] = useState<DedicatedIpPayload | null>(null)

  const load = async () => {
    setTeam(await api.get<TeamPayload>(`/t/${tenantId}/team`))
    setSettings(await api.get<SettingsPayload>(`/t/${tenantId}/settings`))
    // Both are owner-scoped, so a 403 for other roles is expected.
    await api.get<SsoPayload>(`/t/${tenantId}/sso`).then(setSso).catch(() => setSso(null))
    await api.get<DedicatedIpPayload>(`/t/${tenantId}/dedicated-ip`).then(setDedicated).catch(() => setDedicated(null))
  }
  useEffect(() => { void load() }, [tenantId])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    }
  }

  async function saveSettings(patch: Partial<SettingsPayload> | { notifications: Record<string, unknown> }) {
    await act(async () => {
      await api.patch(`/t/${tenantId}/settings`, patch)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  if (!team || !settings) return <Spinner />

  const ownerCount = team.members.filter((m) => m.role === 'OWNER').length

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Settings</h1>

      {error && <Banner level="error">{error}</Banner>}
      {saved && <Banner level="info">Saved.</Banner>}

      <Card title="Organization">
        <div className="grid grid-2">
          <Field label="Name">
            <input
              defaultValue={settings.name}
              disabled={!canManageTeam}
              onBlur={(e) => e.target.value !== settings.name && saveSettings({ name: e.target.value })}
            />
          </Field>
          <Field label="Timezone" hint="Used for daily cap resets shown in the dashboard.">
            <input
              defaultValue={settings.timezone}
              disabled={!canManageTeam}
              onBlur={(e) => e.target.value !== settings.timezone && saveSettings({ timezone: e.target.value })}
            />
          </Field>
        </div>
      </Card>

      <Card title="Alert emails">
        <Field label="Send alerts to" hint="Comma separated. Defaults to the owner if left empty.">
          <input
            defaultValue={settings.notifications?.emails.join(', ') ?? ''}
            disabled={!canManageTeam}
            onBlur={(e) =>
              saveSettings({
                notifications: {
                  emails: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                },
              })
            }
          />
        </Field>

        {ALERTS.map(([key, label]) => (
          <label key={key} className="row" style={{ gap: 8, padding: '6px 0' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              disabled={!canManageTeam}
              defaultChecked={settings.notifications?.[key] ?? true}
              onChange={(e) => saveSettings({ notifications: { [key]: e.target.checked } })}
            />
            <span>{label}</span>
          </label>
        ))}
      </Card>

      <Card title="Team">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Member</th><th>Email</th><th>Role</th><th /></tr></thead>
            <tbody>
              {team.members.map((m) => (
                <tr key={m.id}>
                  <td style={{ color: 'var(--ink)', fontWeight: 550 }}>{m.user.name ?? '—'}</td>
                  <td className="mono">{m.user.email}</td>
                  <td>
                    {canManageTeam ? (
                      <select
                        defaultValue={m.role}
                        onChange={(e) => act(() => api.patch(`/t/${tenantId}/team/${m.id}`, { role: e.target.value }))}
                        style={{ maxWidth: 150 }}
                      >
                        {isOwner && <option value="OWNER">Owner</option>}
                        {!(m.role === 'OWNER' && ownerCount <= 1) && (
                          <>
                            <option value="ADMIN">Admin</option>
                            <option value="DEVELOPER">Developer</option>
                            <option value="READ_ONLY">Read only</option>
                          </>
                        )}
                      </select>
                    ) : (
                      m.role.toLowerCase().replace('_', ' ')
                    )}
                    <div className="muted" style={{ fontSize: '.75rem', marginTop: 2 }}>{ROLE_HELP[m.role]}</div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {/* An organization must always keep one owner, so the
                        server refuses this. Do not offer an action that can
                        only fail. */}
                    {canManageTeam && !(m.role === 'OWNER' && ownerCount <= 1) && (
                      <Button
                        variant="danger"
                        className="btn-sm"
                        onClick={() => {
                          if (!confirm(`Remove ${m.user.email}? They are signed out immediately.`)) return
                          void act(() => api.del(`/t/${tenantId}/team/${m.id}`))
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {canManageTeam && (
        <Card title="Invite someone">
          {inviteUrl && (
            <>
              <Banner level="info">
                Invitation emailed. You can also send this link directly — it expires in 7 days.
              </Banner>
              <div style={{ marginBottom: 16 }}><Copyable value={inviteUrl} /></div>
            </>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void act(async () => {
                const r = await api.post<{ invite_url: string }>(`/t/${tenantId}/team/invites`, {
                  email,
                  role: inviteRole,
                })
                setInviteUrl(r.invite_url)
                setEmail('')
              })
            }}
          >
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="Email">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ minWidth: 260 }} />
              </Field>
              <Field label="Role">
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  <option value="ADMIN">Admin</option>
                  <option value="DEVELOPER">Developer</option>
                  <option value="READ_ONLY">Read only</option>
                </select>
              </Field>
              <Button type="submit" variant="primary" style={{ marginBottom: 14 }}>Send invite</Button>
            </div>
          </form>

          <p className="muted" style={{ marginBottom: 0 }}>{ROLE_HELP[inviteRole]}</p>
        </Card>
      )}

      {team.invites.length > 0 && (
        <Card title="Pending invites">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {team.invites.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.email}</td>
                    <td>{i.role.toLowerCase().replace('_', ' ')}</td>
                    <td className="muted">{new Date(i.expiresAt).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      {canManageTeam && (
                        <Button className="btn-sm" onClick={() => act(() => api.del(`/t/${tenantId}/team/invites/${i.id}`))}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {sso && (
        <Card
          title="Single sign-on"
          action={
            canManageTeam && (
              <Button className="btn-sm" onClick={() => {
                if (!editingSso && sso.connection) {
                  setSsoForm({
                    issuer: sso.connection.issuer,
                    client_id: sso.connection.client_id,
                    client_secret: '',
                    domains: sso.connection.domains.join(', '),
                    enforced: sso.connection.enforced,
                    default_role: sso.connection.default_role,
                  })
                }
                setEditingSso(!editingSso)
              }}>
                {editingSso ? 'Cancel' : sso.configured ? 'Edit' : 'Set up'}
              </Button>
            )
          }
        >
          {!sso.configured && !editingSso && (
            <Empty title="Not configured">
              <p>Let your team sign in with Google Workspace, Okta or Entra instead of a password.</p>
            </Empty>
          )}

          {sso.configured && !editingSso && sso.connection && (
            <>
              <table style={{ marginBottom: 14 }}>
                <tbody>
                  <tr><td>Issuer</td><td className="mono">{sso.connection.issuer}</td></tr>
                  <tr><td>Email domains</td><td className="mono">{sso.connection.domains.join(', ')}</td></tr>
                  <tr><td>Default role for new members</td><td>{sso.connection.default_role.toLowerCase().replace('_', ' ')}</td></tr>
                  <tr>
                    <td>Password login</td>
                    <td>{sso.connection.enforced ? 'Blocked for these domains' : 'Still allowed'}</td>
                  </tr>
                </tbody>
              </table>
              <Field label="Your sign-in link" hint="Send this to your team, or link it from your intranet.">
                <Copyable value={sso.login_url} />
              </Field>
              {canManageTeam && (
                <Button variant="danger" className="btn-sm" onClick={() => {
                  if (!confirm('Remove SSO? Members will need passwords again.')) return
                  void act(() => api.del(`/t/${tenantId}/sso`))
                }}>
                  Remove SSO
                </Button>
              )}
            </>
          )}

          {editingSso && (
            <form onSubmit={(e) => {
              e.preventDefault()
              void act(async () => {
                await api.put(`/t/${tenantId}/sso`, {
                  issuer: ssoForm.issuer,
                  client_id: ssoForm.client_id,
                  ...(ssoForm.client_secret ? { client_secret: ssoForm.client_secret } : {}),
                  domains: ssoForm.domains.split(',').map((d) => d.trim()).filter(Boolean),
                  enforced: ssoForm.enforced,
                  default_role: ssoForm.default_role,
                })
                setEditingSso(false)
              })
            }}>
              <Field label="Redirect URI" hint="Paste this into your identity provider first — it will reject the setup otherwise.">
                <Copyable value={sso.redirect_uri} />
              </Field>
              <Field label="Issuer URL" hint="e.g. https://accounts.google.com — we read its discovery document.">
                <input value={ssoForm.issuer} onChange={(e) => setSsoForm({ ...ssoForm, issuer: e.target.value })} placeholder="https://accounts.google.com" required />
              </Field>
              <div className="grid grid-2">
                <Field label="Client ID">
                  <input value={ssoForm.client_id} onChange={(e) => setSsoForm({ ...ssoForm, client_id: e.target.value })} required />
                </Field>
                <Field label="Client secret" hint={sso.configured ? 'Leave blank to keep the current one.' : undefined}>
                  <input type="password" value={ssoForm.client_secret} onChange={(e) => setSsoForm({ ...ssoForm, client_secret: e.target.value })} required={!sso.configured} />
                </Field>
              </div>
              <Field label="Email domains" hint="Comma separated. We only accept sign-ins whose verified email is in one of these.">
                <input value={ssoForm.domains} onChange={(e) => setSsoForm({ ...ssoForm, domains: e.target.value })} placeholder="yourcompany.com" required />
              </Field>
              <Field label="Role for members who sign in for the first time">
                <select value={ssoForm.default_role} onChange={(e) => setSsoForm({ ...ssoForm, default_role: e.target.value })}>
                  <option value="READ_ONLY">Read only</option>
                  <option value="DEVELOPER">Developer</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </Field>
              <label className="row" style={{ gap: 8, marginBottom: 14 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={ssoForm.enforced} onChange={(e) => setSsoForm({ ...ssoForm, enforced: e.target.checked })} />
                <span>Require SSO — block password sign-in for these domains</span>
              </label>
              <Button type="submit" variant="primary">Save SSO configuration</Button>
            </form>
          )}
        </Card>
      )}

      {dedicated && (
        <Card title="Dedicated IP">
          {dedicated.assigned ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Your mail sends from these addresses only. Their reputation is entirely yours.
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Address</th><th>Reverse DNS</th><th>State</th></tr></thead>
                  <tbody>
                    {dedicated.assigned.addresses.map((a) => (
                      <tr key={a.address}>
                        <td className="mono">{a.address}</td>
                        <td className="mono">{a.ptr ?? '—'}</td>
                        <td>
                          {a.warming
                            ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>Warming{a.daily_cap ? ` · ${a.daily_cap.toLocaleString()}/day` : ''}</span>
                            : <span style={{ color: 'var(--ok)', fontWeight: 600 }}>Live</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : dedicated.request && ['NEW', 'INVESTIGATING'].includes(dedicated.request.status) ? (
            <Banner level="info">
              Your request is with us. Allocating an address, setting its reverse DNS and warming
              it takes a few days — we will come back to you with timing.
            </Banner>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                On the shared pool your reputation is pooled with other transactional senders,
                which is usually an advantage. A dedicated IP makes it entirely your own — worth
                it above roughly 100,000 messages a month, and not before, since a new IP starts
                with no reputation at all and has to be warmed.
              </p>
              {isOwner && (
                <Button variant="primary" onClick={() => act(() => api.post(`/t/${tenantId}/dedicated-ip`, {}))}>
                  Request a dedicated IP
                </Button>
              )}
            </>
          )}
        </Card>
      )}

      {isOwner && (
        <Card title="Close account">
          <p className="muted" style={{ marginTop: 0 }}>
            Sending stops immediately and every credential is revoked. Your message history
            and invoices are retained for billing and abuse records; contact support for
            deletion.
          </p>
          <Button
            variant="danger"
            onClick={() => {
              if (!confirm('Close this account? Sending stops immediately and all API keys stop working.')) return
              void act(() => api.post(`/t/${tenantId}/settings/close`, { confirm: true }))
            }}
          >
            Close this account
          </Button>
        </Card>
      )}
    </>
  )
}
