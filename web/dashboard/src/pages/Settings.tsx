import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { Banner, Button, Card, Copyable, Field, Spinner } from '../ui'

interface TeamPayload {
  members: Array<{ id: string; role: string; user: { id: string; email: string; name: string | null } }>
  invites: Array<{ id: string; email: string; role: string; expiresAt: string }>
}

const ROLE_HELP: Record<string, string> = {
  OWNER: 'Everything, including billing and closing the account.',
  ADMIN: 'Everything except billing.',
  DEVELOPER: 'Send, manage domains and credentials. No team or billing access.',
  READ_ONLY: 'View activity and domains. Cannot send.',
}

export default function Settings({ tenantId, role }: { tenantId: string; role: string }) {
  const [team, setTeam] = useState<TeamPayload | null>(null)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('DEVELOPER')
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canManageTeam = role.toUpperCase() === 'OWNER' || role.toUpperCase() === 'ADMIN'

  const load = () => api.get<TeamPayload>(`/t/${tenantId}/team`).then(setTeam)
  useEffect(() => { void load() }, [tenantId])

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const r = await api.post<{ invite_url: string }>(`/t/${tenantId}/team/invites`, {
        email,
        role: inviteRole,
      })
      setInviteUrl(r.invite_url)
      setEmail('')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the invite')
    }
  }

  if (!team) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Settings</h1>

      {error && <Banner level="error">{error}</Banner>}

      <Card title="Team">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Member</th><th>Email</th><th>Role</th></tr></thead>
            <tbody>
              {team.members.map((m) => (
                <tr key={m.id}>
                  <td style={{ color: 'var(--ink)', fontWeight: 550 }}>{m.user.name ?? '—'}</td>
                  <td className="mono">{m.user.email}</td>
                  <td>
                    {m.role.toLowerCase().replace('_', ' ')}
                    <div className="muted" style={{ fontSize: '.75rem' }}>{ROLE_HELP[m.role]}</div>
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
                Invite created. Send them this link — it expires in 7 days.
              </Banner>
              <div style={{ marginBottom: 16 }}><Copyable value={inviteUrl} /></div>
            </>
          )}

          <form onSubmit={invite}>
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
              <thead><tr><th>Email</th><th>Role</th><th>Expires</th></tr></thead>
              <tbody>
                {team.invites.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.email}</td>
                    <td>{i.role.toLowerCase().replace('_', ' ')}</td>
                    <td className="muted">{new Date(i.expiresAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}
