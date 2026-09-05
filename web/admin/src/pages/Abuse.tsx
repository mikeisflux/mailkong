import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AbuseRow } from '../api'
import { Button, Card, Empty, Spinner, Status, relative } from '../ui'

export default function Abuse() {
  const [rows, setRows] = useState<AbuseRow[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = () => api.get<{ data: AbuseRow[] }>('/abuse').then((r) => setRows(r.data))
  useEffect(() => { void load() }, [])

  async function update(id: string, status: string) {
    await api.patch(`/abuse/${id}`, { status })
    await load()
  }

  if (!rows) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Abuse queue</h1>

      {rows.length === 0 ? (
        <Card>
          <Empty title="Queue is empty">
            <p>Feedback loop reports and automatic bounce-spike pauses land here.</p>
          </Empty>
        </Card>
      ) : (
        rows.map((t) => (
          <Card
            key={t.id}
            title={t.subject ?? t.source}
            action={
              <div className="row">
                <Status value={t.status} />
                <Button className="btn-sm" onClick={() => setOpen(open === t.id ? null : t.id)}>
                  {open === t.id ? 'Hide' : 'Raw'}
                </Button>
                {t.status === 'NEW' && (
                  <Button className="btn-sm" onClick={() => update(t.id, 'INVESTIGATING')}>Take</Button>
                )}
                {t.status !== 'RESOLVED' && (
                  <Button className="btn-sm" variant="primary" onClick={() => update(t.id, 'RESOLVED')}>Resolve</Button>
                )}
              </div>
            }
          >
            <p className="muted" style={{ marginTop: 0 }}>
              {t.source.replace(/_/g, ' ')} · {relative(t.createdAt)}
              {t.tenant && (
                <> · <Link to={`/tenants/${t.tenant.id}`}>{t.tenant.name}</Link> (<Status value={t.tenant.status} />)</>
              )}
            </p>

            {open === t.id && (
              <pre style={{ background: 'var(--bg-3)', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: '.8125rem', margin: 0 }}>
                {t.raw}
              </pre>
            )}
          </Card>
        ))
      )}
    </>
  )
}
