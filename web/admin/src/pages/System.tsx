import { useEffect, useState } from 'react'
import { api, type Operator } from '../api'
import { Banner, Button, Card, Spinner } from '../ui'

interface SystemData {
  flags: Array<{ key: string; enabled: boolean }>
  queue: { queued: number; held: number; workers: number } | null
  postal_reachable: boolean
}

const FLAG_HELP: Record<string, string> = {
  signup_open: 'Allows public self-service signup. Keep this off until the admin console can pause and search — you need both before strangers send through your IPs.',
  inbound_enabled: 'Allows customers to create inbound routes.',
  tracking_enabled: 'Allows open and click tracking on customer servers.',
  maintenance_banner: 'Shows a maintenance notice on the customer dashboard.',
}

export default function System({ me }: { me: Operator }) {
  const [data, setData] = useState<SystemData | null>(null)
  const canWrite = me.role === 'SUPERADMIN'

  const load = () => api.get<SystemData>('/system').then(setData)
  useEffect(() => { void load() }, [])

  async function toggle(key: string, enabled: boolean) {
    await api.put(`/system/flags/${key}`, { enabled })
    await load()
  }

  if (!data) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>System</h1>

      {!data.postal_reachable && (
        <Banner level="error">
          <strong>Postal is unreachable from the control plane.</strong> Sending and
          provisioning are both failing. Check the mail box, the agent process, and the
          firewall between the two machines.
        </Banner>
      )}

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Postal</div>
          <div className="value" style={{ fontSize: '1.25rem', color: data.postal_reachable ? 'var(--ok)' : 'var(--err)' }}>
            {data.postal_reachable ? 'Reachable' : 'Unreachable'}
          </div>
        </div>
        <div className="stat">
          <div className="label">Queued</div>
          <div className="value">{data.queue?.queued?.toLocaleString() ?? '—'}</div>
          <div className="sub">{data.queue?.held ?? 0} held</div>
        </div>
        <div className="stat">
          <div className="label">Workers</div>
          <div className="value">{data.queue?.workers ?? '—'}</div>
        </div>
      </div>

      <Card title="Feature flags">
        {!canWrite && <Banner level="info">Only a superadmin can change flags.</Banner>}
        {data.flags.map((f) => (
          <div key={f.key} style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <code style={{ color: 'var(--ink)', fontWeight: 600 }}>{f.key}</code>
                <div className="muted" style={{ fontSize: '.8125rem', maxWidth: '62ch', marginTop: 2 }}>
                  {FLAG_HELP[f.key] ?? 'No description.'}
                </div>
              </div>
              <Button
                disabled={!canWrite}
                variant={f.enabled ? 'danger' : 'primary'}
                className="btn-sm"
                onClick={() => toggle(f.key, !f.enabled)}
              >
                {f.enabled ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
          </div>
        ))}
      </Card>
    </>
  )
}
