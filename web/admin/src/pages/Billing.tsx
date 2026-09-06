import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type Operator } from '../api'
import { Banner, Button, Card, Empty, Field, Spinner } from '../ui'

interface Payload {
  billing_configured: boolean
  failed_invoices: Array<{
    id: string
    number: string | null
    amount_due: number
    currency: string
    attempt_count: number
    hosted_invoice_url: string | null
    tenant: { id: string; name: string; slug: string; status: string } | null
  }>
  past_due: Array<{ id: string; name: string; slug: string; plan: string | null; reason: string | null; sends_this_cycle: number }>
  comped: Array<{ id: string; name: string; slug: string; plan: string | null; monthly_price: number; has_stripe_customer: boolean }>
  plans: Array<{ id: string; key: string; name: string; monthlyPrice: number }>
}

interface Coupon {
  id: string
  code: string
  description: string | null
  percentOff: number | null
  amountOffCents: number | null
  durationMonths: number | null
  maxRedemptions: number | null
  redemptions: number
  expiresAt: string | null
  active: boolean
}

export default function Billing({ me }: { me: Operator }) {
  const [data, setData] = useState<Payload | null>(null)
  const [coupons, setCoupons] = useState<Coupon[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [addingCoupon, setAddingCoupon] = useState(false)
  const [coupon, setCoupon] = useState({ code: '', description: '', percent_off: '', amount_off_cents: '', duration_months: '' })
  const [refund, setRefund] = useState<{ tenantId: string; name: string } | null>(null)
  const [refundForm, setRefundForm] = useState({ kind: 'credit', amount: '', reason: '' })

  const canRefund = ['SUPERADMIN', 'BILLING'].includes(me.role)

  const load = async () => {
    setData(await api.get<Payload>('/billing'))
    setCoupons((await api.get<{ data: Coupon[] }>('/coupons')).data)
  }
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

  if (!data || !coupons) return <Spinner />

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>Billing</h1>

      {error && <Banner level="error">{error}</Banner>}
      {notice && <Banner level="info">{notice}</Banner>}
      {!data.billing_configured && (
        <Banner level="warning">
          Stripe is not configured on this deployment. Invoice and coupon operations are
          unavailable; plans and comped accounts still work.
        </Banner>
      )}

      <Card title={`Failed invoices (${data.failed_invoices.length})`}>
        <p className="muted" style={{ marginTop: 0 }}>
          Read from Stripe directly, not from our tenant status — a charge can fail before the
          webhook that would mark the account past due has landed.
        </p>
        {data.failed_invoices.length === 0 ? (
          <Empty title="No failed invoices" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Invoice</th><th>Tenant</th><th>Amount</th><th>Attempts</th><th /></tr></thead>
              <tbody>
                {data.failed_invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number ?? i.id}</td>
                    <td>{i.tenant ? <Link to={`/tenants/${i.tenant.id}`}>{i.tenant.name}</Link> : <span className="muted">unmatched</span>}</td>
                    <td className="num">${(i.amount_due / 100).toFixed(2)} {i.currency.toUpperCase()}</td>
                    <td className="num">{i.attempt_count}</td>
                    <td style={{ textAlign: 'right' }}>
                      {i.hosted_invoice_url && <a href={i.hosted_invoice_url} target="_blank" rel="noreferrer">Open in Stripe</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Past due (${data.past_due.length})`}>
        {data.past_due.length === 0 ? <Empty title="No accounts past due" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tenant</th><th>Plan</th><th>Sends this cycle</th><th>Reason</th><th /></tr></thead>
              <tbody>
                {data.past_due.map((t) => (
                  <tr key={t.id}>
                    <td><Link to={`/tenants/${t.id}`}>{t.name}</Link></td>
                    <td>{t.plan ?? '—'}</td>
                    <td className="num">{t.sends_this_cycle.toLocaleString()}</td>
                    <td className="muted" style={{ maxWidth: 260 }}>{t.reason ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {canRefund && (
                        <Button className="btn-sm" onClick={() => { setRefund({ tenantId: t.id, name: t.name }); setRefundForm({ kind: 'credit', amount: '', reason: '' }) }}>
                          Refund / credit
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {refund && (
        <Card title={`Refund or credit — ${refund.name}`} action={<Button className="btn-sm" onClick={() => setRefund(null)}>Cancel</Button>}>
          <p className="muted" style={{ marginTop: 0 }}>
            A refund returns money to their card. A credit sits on their Stripe customer and
            reduces the next invoice. Credit is usually the right answer for a service problem.
          </p>
          <form onSubmit={(e) => {
            e.preventDefault()
            void act(async () => {
              await api.post(`/tenants/${refund.tenantId}/refund`, {
                kind: refundForm.kind,
                amount_cents: Math.round(Number(refundForm.amount) * 100),
                reason: refundForm.reason,
              })
              setNotice(`${refundForm.kind === 'refund' ? 'Refund' : 'Credit'} issued to ${refund.name}.`)
              setRefund(null)
            })
          }}>
            <div className="grid grid-3">
              <Field label="Type">
                <select value={refundForm.kind} onChange={(e) => setRefundForm({ ...refundForm, kind: e.target.value })}>
                  <option value="credit">Account credit</option>
                  <option value="refund">Refund to card</option>
                </select>
              </Field>
              <Field label="Amount (USD)">
                <input type="number" step="0.01" min="0.01" value={refundForm.amount} onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })} required />
              </Field>
              <Field label="Reason" hint="Recorded in the audit log.">
                <input value={refundForm.reason} onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })} required />
              </Field>
            </div>
            <Button type="submit" variant="primary">Issue {refundForm.kind}</Button>
          </form>
        </Card>
      )}

      <Card
        title={`Coupons (${coupons.filter((c) => c.active).length} active)`}
        action={canRefund && <Button className="btn-sm" onClick={() => setAddingCoupon(!addingCoupon)}>{addingCoupon ? 'Cancel' : 'New coupon'}</Button>}
      >
        {addingCoupon && (
          <form
            style={{ marginBottom: 16 }}
            onSubmit={(e) => {
              e.preventDefault()
              void act(async () => {
                await api.post('/coupons', {
                  code: coupon.code.toUpperCase(),
                  description: coupon.description || undefined,
                  percent_off: coupon.percent_off ? Number(coupon.percent_off) : undefined,
                  amount_off_cents: coupon.amount_off_cents ? Math.round(Number(coupon.amount_off_cents) * 100) : undefined,
                  duration_months: coupon.duration_months ? Number(coupon.duration_months) : undefined,
                })
                setCoupon({ code: '', description: '', percent_off: '', amount_off_cents: '', duration_months: '' })
                setAddingCoupon(false)
              })
            }}
          >
            <div className="grid grid-3">
              <Field label="Code" hint="What the customer types at checkout.">
                <input value={coupon.code} onChange={(e) => setCoupon({ ...coupon, code: e.target.value.toUpperCase() })} placeholder="LAUNCH20" required />
              </Field>
              <Field label="Percent off">
                <input type="number" min="1" max="100" value={coupon.percent_off} onChange={(e) => setCoupon({ ...coupon, percent_off: e.target.value, amount_off_cents: '' })} />
              </Field>
              <Field label="or amount off (USD)">
                <input type="number" step="0.01" min="0.01" value={coupon.amount_off_cents} onChange={(e) => setCoupon({ ...coupon, amount_off_cents: e.target.value, percent_off: '' })} />
              </Field>
            </div>
            <div className="grid grid-2">
              <Field label="Description">
                <input value={coupon.description} onChange={(e) => setCoupon({ ...coupon, description: e.target.value })} />
              </Field>
              <Field label="Months it applies for" hint="Blank means one invoice only.">
                <input type="number" min="1" max="36" value={coupon.duration_months} onChange={(e) => setCoupon({ ...coupon, duration_months: e.target.value })} />
              </Field>
            </div>
            <Button type="submit" variant="primary">Create coupon</Button>
          </form>
        )}

        {coupons.length === 0 ? <Empty title="No coupons" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Code</th><th>Discount</th><th>Duration</th><th>Redeemed</th><th>State</th><th /></tr></thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                    <td className="mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>{c.code}</td>
                    <td>{c.percentOff ? `${c.percentOff}%` : c.amountOffCents ? `$${(c.amountOffCents / 100).toFixed(2)}` : '—'}</td>
                    <td>{c.durationMonths ? `${c.durationMonths} months` : 'one invoice'}</td>
                    <td className="num">{c.redemptions}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}</td>
                    <td>{c.active ? 'active' : 'inactive'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {canRefund && c.active && (
                        <Button className="btn-sm" variant="danger" onClick={() => act(() => api.del(`/coupons/${c.code}`))}>
                          Deactivate
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Comped accounts (${data.comped.length})`}>
        <p className="muted" style={{ marginTop: 0 }}>
          Accounts on a zero-price plan or with no Stripe customer at all — everything we are
          not charging.
        </p>
        {data.comped.length === 0 ? <Empty title="None" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tenant</th><th>Plan</th><th>Billing profile</th></tr></thead>
              <tbody>
                {data.comped.map((t) => (
                  <tr key={t.id}>
                    <td><Link to={`/tenants/${t.id}`}>{t.name}</Link></td>
                    <td>{t.plan ?? <span className="muted">none</span>}</td>
                    <td className="muted">{t.has_stripe_customer ? 'has a Stripe customer' : 'no Stripe customer'}</td>
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
