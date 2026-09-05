import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { Banner, Button, Card, Copyable, Field, Spinner } from '../ui'

interface TeamPayload {
  members: Array<{ id: string; role: string; user: { id: string; email: string; name: string | null } }>
  invites: Array<{ id: string; email: string; role: string; expiresAt: string }>
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

  const load = async () => {
    setTeam(await api.get<TeamPayload>(`/t/${tenantId}/team`))
    setSettings(await api.get<SettingsPayload>(`/t/${tenantId}/settings`))
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
                        <option value="ADMIN">Admin</option>
                        <option value="DEVELOPER">Developer</option>
                        <option value="READ_ONLY">Read only</option>
                      </select>
                    ) : (
                      m.role.toLowerCase().replace('_', ' ')
                    )}
                    <div className="muted" style={{ fontSize: '.75rem', marginTop: 2 }}>{ROLE_HELP[m.role]}</div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {canManageTeam && (
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
