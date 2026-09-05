import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, Empty, Spinner } from '../ui'

interface Plan {
  id: string
  key: string
  name: string
  monthlyPrice: number
  limits: Record<string, number | boolean>
  hardStop: boolean
  public: boolean
  stripePriceId: string | null
}

export default function Plans() {
  const [plans, setPlans] = useState<Plan[] | null>(null)
  useEffect(() => { void api.get<{ data: Plan[] }>('/plans').then((r) => setPlans(r.data)) }, [])
  if (!plans) return <Spinner />

  const fmt = (v: number | boolean) =>
    typeof v === 'boolean' ? (v ? 'yes' : 'no') : v < 0 ? 'unlimited' : v.toLocaleString()

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Plans</h1>
      <Card title="Limits are stored as JSON">
        <p className="muted" style={{ margin: 0 }}>
          Plans can be changed without a migration. Changing a limit takes effect on the
          next request; it does not retroactively pause tenants already over the new
          number — move those deliberately from the tenant screen.
        </p>
      </Card>

      {plans.length === 0 ? <Card><Empty title="No plans" /></Card> : (
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Plan</th><th>Price</th><th>Monthly sends</th><th>Domains</th>
                  <th>Webhooks</th><th>Routes</th><th>Retention</th><th>Overage</th><th>Public</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong style={{ color: 'var(--ink)' }}>{p.name}</strong>
                      <div className="muted" style={{ fontSize: '.75rem' }}>{p.key}</div>
                    </td>
                    <td className="num">{p.monthlyPrice === 0 ? 'free' : `$${(p.monthlyPrice / 100).toFixed(0)}`}</td>
                    <td className="num">{fmt(p.limits.monthlySends ?? 0)}</td>
                    <td className="num">{fmt(p.limits.domains ?? 0)}</td>
                    <td className="num">{fmt(p.limits.webhooks ?? 0)}</td>
                    <td className="num">{fmt(p.limits.routes ?? 0)}</td>
                    <td className="num">{fmt(p.limits.retentionDays ?? 0)} days</td>
                    <td>{p.hardStop ? 'hard stop' : 'metered'}</td>
                    <td>{p.public ? 'yes' : 'internal'}</td>
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
