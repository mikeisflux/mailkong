import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getStripe } from '../billing/stripe.js'
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js'
import { readAdminSession } from '../auth/session.js'
import { requireAdmin, type AdminCapability } from '../auth/rbac.js'
import { audit } from '../services/audit.js'
import { resumeTenant } from '../services/provisioning.js'
import type { AdminUser } from '@prisma/client'

/**
 * Billing administration, spec 9.2: failed invoices, coupons, refunds, and
 * comped accounts.
 *
 * Stripe stays the system of record for money. Nothing here writes an amount
 * into our database -- it reads Stripe and issues Stripe operations, so the
 * two can never disagree about what a customer was charged.
 */
export async function billingAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/billing', async (req) => {
    await operator(req)
    const stripe = getStripe()

    const [pastDue, comped, plans] = await Promise.all([
      prisma.tenant.findMany({
        where: { status: 'PAST_DUE' },
        include: { plan: true, subscription: true },
        orderBy: { updatedAt: 'desc' },
      }),
      // Comped accounts: on a zero-price plan, or with no Stripe customer at
      // all. Both are "we are not charging this one", which is what an
      // operator is actually looking for.
      prisma.tenant.findMany({
        where: { OR: [{ plan: { monthlyPrice: 0 } }, { stripeCustomerId: null }] },
        include: { plan: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.plan.findMany({ orderBy: { monthlyPrice: 'asc' } }),
    ])

    let failedInvoices: Array<Record<string, unknown>> = []
    if (stripe) {
      // Stripe is the source of truth for what failed, not our tenant status:
      // a charge can fail without our webhook having landed yet.
      const list = await stripe.invoices.list({ status: 'open', limit: 50 })
      const failing = list.data.filter((i) => (i.attempt_count ?? 0) > 0)

      const customers = failing.map((i) => (typeof i.customer === 'string' ? i.customer : i.customer?.id)).filter(Boolean) as string[]
      const tenants = await prisma.tenant.findMany({
        where: { stripeCustomerId: { in: customers } },
        select: { id: true, name: true, slug: true, status: true, stripeCustomerId: true },
      })
      const byCustomer = new Map(tenants.map((t) => [t.stripeCustomerId!, t]))

      failedInvoices = failing.map((i) => {
        const customerId = typeof i.customer === 'string' ? i.customer : i.customer?.id
        return {
          id: i.id,
          number: i.number,
          amount_due: i.amount_due,
          currency: i.currency,
          attempt_count: i.attempt_count,
          due_date: i.due_date ? new Date(i.due_date * 1000).toISOString() : null,
          hosted_invoice_url: i.hosted_invoice_url,
          tenant: customerId ? (byCustomer.get(customerId) ?? null) : null,
        }
      })
    }

    return {
      billing_configured: stripe !== null,
      failed_invoices: failedInvoices,
      past_due: pastDue.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        plan: t.plan?.key ?? null,
        reason: t.statusReason,
        sends_this_cycle: t.subscription?.sendsUsed ?? 0,
      })),
      comped: comped.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        plan: t.plan?.key ?? null,
        monthly_price: t.plan?.monthlyPrice ?? 0,
        has_stripe_customer: t.stripeCustomerId !== null,
      })),
      plans,
    }
  })

  /**
   * Refund or credit. Refunds go back to the card; credits sit on the Stripe
   * customer and reduce the next invoice.
   */
  app.post<{ Params: { id: string } }>('/tenants/:id/refund', async (req) => {
    const admin = await operator(req, 'refunds')
    const body = z.object({
      kind: z.enum(['refund', 'credit']),
      amount_cents: z.number().int().min(1).max(1_000_000),
      reason: z.string().min(3).max(300),
      invoice_id: z.string().optional(),
    }).parse(req.body)

    const stripe = getStripe()
    if (!stripe) throw badRequest('billing_unavailable', 'Billing is not configured on this deployment')

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } })
    if (!tenant?.stripeCustomerId) throw notFound('Stripe customer for this tenant')

    let result: { id: string; kind: string }

    if (body.kind === 'refund') {
      const invoiceId =
        body.invoice_id ??
        (await stripe.invoices.list({ customer: tenant.stripeCustomerId, status: 'paid', limit: 1 }))
          .data[0]?.id
      if (!invoiceId) throw badRequest('no_invoice', 'This customer has no paid invoice to refund')

      const invoice = await stripe.invoices.retrieve(invoiceId)
      const chargeId = typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id
      if (!chargeId) throw badRequest('no_charge', 'That invoice has no charge attached')

      if (body.amount_cents > invoice.amount_paid) {
        throw conflict('amount_exceeds_invoice', `That invoice was ${invoice.amount_paid} cents; you cannot refund more.`)
      }

      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: body.amount_cents,
        metadata: { operator: admin.email, reason: body.reason },
      })
      result = { id: refund.id, kind: 'refund' }
    } else {
      // A negative balance transaction is a credit in Stripe's model.
      const entry = await stripe.customers.createBalanceTransaction(tenant.stripeCustomerId, {
        amount: -body.amount_cents,
        currency: 'usd',
        description: body.reason,
        metadata: { operator: admin.email },
      })
      result = { id: entry.id, kind: 'credit' }
    }

    await audit({
      action: `billing.${body.kind}_issued`,
      adminId: admin.id,
      tenantId: tenant.id,
      payload: { amount_cents: body.amount_cents, reason: body.reason, stripe_id: result.id },
      ip: req.ip,
    })
    return result
  })

  /** Comp an account: move it to a zero-price plan and lift a past-due pause. */
  app.post<{ Params: { id: string } }>('/tenants/:id/comp', async (req) => {
    const admin = await operator(req, 'refunds')
    const body = z.object({
      plan_key: z.string().default('internal'),
      reason: z.string().min(3).max(300),
    }).parse(req.body)

    const [tenant, plan] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: req.params.id } }),
      prisma.plan.findUnique({ where: { key: body.plan_key } }),
    ])
    if (!tenant) throw notFound('Tenant')
    if (!plan) throw badRequest('unknown_plan', `No plan with key "${body.plan_key}"`)
    if (plan.monthlyPrice !== 0) {
      throw badRequest('not_a_comp_plan', 'Comping requires a zero-price plan')
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { planId: plan.id, notes: [tenant.notes, `Comped: ${body.reason}`].filter(Boolean).join('\n') },
    })
    if (tenant.status === 'PAST_DUE') await resumeTenant(tenant.id, admin.id)

    await audit({
      action: 'billing.comped',
      adminId: admin.id,
      tenantId: tenant.id,
      payload: { plan: plan.key, reason: body.reason },
      ip: req.ip,
    })
    return { ok: true }
  })

  // ---------------------------------------------------------------- coupons

  app.get('/coupons', async (req) => {
    await operator(req)
    return { data: await prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } }) }
  })

  app.post('/coupons', async (req, reply) => {
    const admin = await operator(req, 'plans:write')
    const body = z.object({
      code: z.string().min(3).max(40).regex(/^[A-Z0-9_-]+$/, 'Use capitals, digits, dashes and underscores'),
      description: z.string().max(200).optional(),
      percent_off: z.number().int().min(1).max(100).optional(),
      amount_off_cents: z.number().int().min(1).optional(),
      duration_months: z.number().int().min(1).max(36).optional(),
      max_redemptions: z.number().int().min(1).optional(),
      expires_at: z.coerce.date().optional(),
    }).parse(req.body)

    if (!body.percent_off && !body.amount_off_cents) {
      throw badRequest('no_discount', 'Set either a percentage or a fixed amount')
    }
    if (body.percent_off && body.amount_off_cents) {
      throw badRequest('ambiguous_discount', 'Set a percentage or a fixed amount, not both')
    }
    if (await prisma.coupon.findUnique({ where: { code: body.code } })) {
      throw conflict('code_taken', 'That code already exists')
    }

    // Created in Stripe first: a coupon that exists here but not in Stripe
    // would be a code customers can type that silently does nothing.
    const stripe = getStripe()
    let stripeCouponId: string | null = null
    if (stripe) {
      const coupon = await stripe.coupons.create({
        name: body.description ?? body.code,
        ...(body.percent_off ? { percent_off: body.percent_off } : {}),
        ...(body.amount_off_cents ? { amount_off: body.amount_off_cents, currency: 'usd' } : {}),
        duration: body.duration_months ? 'repeating' : 'once',
        ...(body.duration_months ? { duration_in_months: body.duration_months } : {}),
        ...(body.max_redemptions ? { max_redemptions: body.max_redemptions } : {}),
        ...(body.expires_at ? { redeem_by: Math.floor(body.expires_at.getTime() / 1000) } : {}),
      })
      stripeCouponId = coupon.id

      // The promotion code is what a customer types; the coupon is the
      // discount it maps to.
      await stripe.promotionCodes.create({ coupon: coupon.id, code: body.code })
    }

    const created = await prisma.coupon.create({
      data: {
        code: body.code,
        stripeCouponId,
        description: body.description ?? null,
        percentOff: body.percent_off ?? null,
        amountOffCents: body.amount_off_cents ?? null,
        durationMonths: body.duration_months ?? null,
        maxRedemptions: body.max_redemptions ?? null,
        expiresAt: body.expires_at ?? null,
        createdBy: admin.id,
      },
    })

    await audit({ action: 'coupon.created', adminId: admin.id, payload: { code: body.code }, ip: req.ip })
    reply.code(201)
    return { ...created, stripe_configured: stripe !== null }
  })

  app.delete<{ Params: { code: string } }>('/coupons/:code', async (req, reply) => {
    const admin = await operator(req, 'plans:write')
    const coupon = await prisma.coupon.findUnique({ where: { code: req.params.code } })
    if (!coupon) throw notFound('Coupon')

    const stripe = getStripe()
    if (stripe && coupon.stripeCouponId) {
      // Deleting the Stripe coupon stops new redemptions; subscriptions that
      // already carry it keep their discount, which is the correct behaviour.
      await stripe.coupons.del(coupon.stripeCouponId).catch(() => undefined)
    }

    await prisma.coupon.update({ where: { id: coupon.id }, data: { active: false } })
    await audit({ action: 'coupon.deactivated', adminId: admin.id, payload: { code: coupon.code }, ip: req.ip })
    reply.code(204)
  })
}

async function operator(req: FastifyRequest, capability?: AdminCapability): Promise<AdminUser> {
  const admin = await readAdminSession(req)
  if (!admin) throw unauthorized('Operator sign-in required')
  if (capability) requireAdmin(admin.role, capability)
  return admin
}
