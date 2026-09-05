import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Card, Check, Empty, Spinner, Status, relative } from '../ui'

interface Row {
  id: string
  name: string
  kind: string
  tenant: { id: string; name: string; slug: string; status: string }
  spf: boolean
  dkim: boolean
  dmarc: boolean
  verified: boolean
  last_checked_at: string | null
  last_check_output: string | null
}

const STATES = [
  ['all', 'All domains'],
  ['broken', 'Broken — verified once, failing now'],
  ['unverified', 'Never verified'],
  ['verified', 'Verified'],
] as const

export default function Domains() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [search, setSearch] = useState('')
  const [state, setState] = useState<string>('all')

  const load = useCallback(async () => {
    const params = new URLSearchParams({ state })
    if (search) params.set('search', search)
    setRows((await api.get<{ data: Row[] }>(`/domains?${params}`)).data)
  }, [search, state])

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, search])

  return (
    <>
      <h1 style={{ marginBottom: 6 }}>Domains</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Every customer sending domain. "Broken" is the filter worth checking daily — those
        customers' mail is failing right now and they may not know.
      </p>

      <Card>
        <div className="row">
          <input
            placeholder="Search domain name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <select value={state} onChange={(e) => setState(e.target.value)} style={{ maxWidth: 300 }}>
            {STATES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </div>
      </Card>

      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? (
          <Empty title="No domains match" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Domain</th><th>Tenant</th><th>Checks</th><th>Last checked</th><th>Last error</th></tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong style={{ color: 'var(--ink)' }}>{d.name}</strong>
                      <div className="muted" style={{ fontSize: '.75rem' }}>{d.kind.toLowerCase()}</div>
                    </td>
                    <td>
                      <Link to={`/tenants/${d.tenant.id}`}>{d.tenant.name}</Link>
                      <div><Status value={d.tenant.status} /></div>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <Check ok={d.spf} label="SPF" />
                        <Check ok={d.dkim} label="DKIM" />
                        <Check ok={d.dmarc} label="DMARC" />
                      </span>
                    </td>
                    <td className="muted">{d.last_checked_at ? relative(d.last_checked_at) : 'never'}</td>
                    <td className="muted" style={{ fontSize: '.75rem', maxWidth: 300, overflowWrap: 'anywhere' }}>
                      {d.last_check_output ?? '—'}
                    </td>
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
