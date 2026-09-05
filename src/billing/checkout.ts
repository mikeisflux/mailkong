import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { getStripe } from './stripe.js'
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js'
import { readSession } from '../auth/session.js'
import { requireMember } from '../auth/rbac.js'
import { audit } from '../services/audit.js'

/**
 * Subscribe, change plan, and manage payment details.
 *
 * All of it goes through Stripe Checkout and the Billing Portal rather than
 * collecting card details ourselves: card data never touches this server, so
 * PCI scope stays with Stripe.
 *
 * Nothing here mutates the subscription in our database. Stripe's webhooks
 * are the only writer (see billing/webhooks.ts) -- otherwise a customer who
 * closes the tab mid-checkout leaves us believing they upgraded.
 */
export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  app.get('/t/:tenantId/billing', async (req) => {
    const { tenantId } = await ownerContext(req)
    const [tenant, plans] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        include: { plan: true, subscription: true },
      }),
      prisma.plan.findMany({ where: { public: true }, orderBy: { monthlyPrice: 'asc' } }),
    ])

    const stripe = getStripe()
    let invoices: Array<{ id: string; number: string | null; amount: number; status: string; url: string | null; created: string }> = []

    if (stripe && tenant.stripeCustomerId) {
      const list = await stripe.invoices.list({ customer: tenant.stripeCustomerId, limit: 12 })
      invoices = list.data.map((i) => ({
        id: i.id,
        number: i.number,
        amount: i.amount_due,
        status: i.status ?? 'unknown',
        url: i.hosted_invoice_url ?? null,
        created: new Date(i.created * 1000).toISOString(),
      }))
    }

    return {
      billing_configured: stripe !== null,
      plan: tenant.plan,
      subscription: tenant.subscription,
      plans,
      invoices,
    }
  })

  app.post('/t/:tenantId/billing/checkout', async (req) => {
    const { tenantId, userId } = await ownerContext(req)
    const body = z.object({ plan_key: z.string() }).parse(req.body)

    const stripe = getStripe()
    if (!stripe) throw badRequest('billing_unavailable', 'Billing is not configured on this deployment')

    const [tenant, plan] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      prisma.plan.findUnique({ where: { key: body.plan_key } }),
    ])
    if (!plan) throw notFound('Plan')
    if (!plan.stripePriceId) {
      throw badRequest(
        'plan_not_purchasable',
        `The ${plan.name} plan has no Stripe price attached yet. Contact support.`,
      )
    }
    if (!tenant.stripeCustomerId) {
      throw badRequest('no_customer', 'This account has no billing profile. Contact support.')
    }

    const existing = await prisma.subscription.findUnique({ where: { tenantId } })

    // An existing subscription is a plan CHANGE, which Stripe prorates in
    // place. Sending them through Checkout again would create a second
    // subscription and bill them twice.
    if (existing?.stripeSubscriptionId) {
      const sub = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId)
      const item = sub.items.data[0]
      if (!item) throw badRequest('subscription_malformed', 'Contact support')

      await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: plan.stripePriceId }],
        proration_behavior: 'create_prorations',
      })
      await audit({
        action: 'billing.plan_changed',
        actorType: 'user',
        actorId: userId,
        tenantId,
        payload: { to: plan.key },
      })
      // The webhook writes the new plan; the UI just reloads.
      return { changed: true, url: null }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: tenant.stripeCustomerId,
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: `${config.APP_URL}/t/${tenantId}/usage?checkout=success`,
      cancel_url: `${config.APP_URL}/t/${tenantId}/usage?checkout=cancelled`,
      client_reference_id: tenantId,
      subscription_data: { metadata: { tenantId, planKey: plan.key } },
      allow_promotion_codes: true,
    })

    await audit({
      action: 'billing.checkout_started',
      actorType: 'user',
      actorId: userId,
      tenantId,
      payload: { plan: plan.key },
    })
    return { changed: false, url: session.url }
  })

  /** Stripe's hosted portal: cards, invoices, cancellation. */
  app.post('/t/:tenantId/billing/portal', async (req) => {
    const { tenantId } = await ownerContext(req)
    const stripe = getStripe()
    if (!stripe) throw badRequest('billing_unavailable', 'Billing is not configured on this deployment')

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    if (!tenant.stripeCustomerId) throw badRequest('no_customer', 'This account has no billing profile')

    const session = await stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: `${config.APP_URL}/t/${tenantId}/usage`,
    })
    return { url: session.url }
  })
}

/** Billing is owner-only, per the role matrix in spec 8.3. */
async function ownerContext(req: FastifyRequest): Promise<{ userId: string; tenantId: string }> {
  const session = await readSession(req)
  if (!session) throw unauthorized('Not signed in')

  const tenantId = (req.params as { tenantId?: string }).tenantId
  if (!tenantId) throw badRequest('missing_tenant', 'No organization in the request path')

  const membership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: session.userId, tenantId } },
  })
  if (!membership) throw forbidden('not_a_member', 'You do not have access to this organization')
  requireMember(membership.role, 'billing')

  return { userId: session.userId, tenantId }
}
