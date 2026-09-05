import type { FastifyInstance } from 'fastify'
import type Stripe from 'stripe'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { getStripe } from './stripe.js'
import { logger } from '../lib/logger.js'
import { audit } from '../services/audit.js'
import { pauseTenant, resumeTenant } from '../services/provisioning.js'
import { notifyTenant } from '../mail/mailer.js'
import { templates } from '../mail/templates.js'

/**
 * Stripe webhook ingress.
 *
 * Signature verification needs the exact bytes Stripe signed, so this route
 * opts out of Fastify's JSON parser and keeps the raw buffer.
 */
export async function stripeWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  )

  app.post('/webhook', async (req, reply) => {
    const stripe = getStripe()
    if (!stripe || !config.STRIPE_WEBHOOK_SECRET) {
      reply.code(503)
      return { error: 'billing is not configured' }
    }

    const signature = req.headers['stripe-signature']
    if (typeof signature !== 'string') {
      reply.code(400)
      return { error: 'missing signature' }
    }

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        signature,
        config.STRIPE_WEBHOOK_SECRET,
      )
    } catch (err) {
      logger.warn({ err }, 'rejected stripe webhook with bad signature')
      reply.code(400)
      return { error: 'invalid signature' }
    }

    try {
      await handle(event)
    } catch (err) {
      // 500 makes Stripe retry, which is what we want for a transient fault.
      logger.error({ err, type: event.type }, 'stripe webhook handler failed')
      reply.code(500)
      return { error: 'handler failed' }
    }

    return { received: true }
  })
}

async function handle(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const tenant = await tenantByCustomer(sub.customer)
      if (!tenant) return

      const priceId = sub.items.data[0]?.price.id
      const plan = priceId
        ? await prisma.plan.findFirst({ where: { stripePriceId: priceId } })
        : null

      await prisma.subscription.upsert({
        where: { tenantId: tenant.id },
        create: {
          tenantId: tenant.id,
          stripeSubscriptionId: sub.id,
          planId: plan?.id ?? tenant.planId ?? '',
          status: sub.status,
          periodStart: new Date(sub.current_period_start * 1000),
          periodEnd: new Date(sub.current_period_end * 1000),
        },
        update: {
          stripeSubscriptionId: sub.id,
          status: sub.status,
          periodStart: new Date(sub.current_period_start * 1000),
          periodEnd: new Date(sub.current_period_end * 1000),
          ...(plan ? { planId: plan.id } : {}),
          // A new billing period resets the counter. This is the only place
          // sendsUsed goes back to zero.
          ...(sub.status === 'active' ? {} : {}),
        },
      })

      if (plan && plan.id !== tenant.planId) {
        await prisma.tenant.update({ where: { id: tenant.id }, data: { planId: plan.id } })
      }
      break
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice
      const tenant = await tenantByCustomer(invoice.customer)
      if (!tenant) return

      // New cycle: reset usage and lift a past-due pause.
      await prisma.subscription.updateMany({
        where: { tenantId: tenant.id },
        data: { sendsUsed: 0, status: 'active' },
      })
      if (tenant.status === 'PAST_DUE') await resumeTenant(tenant.id)
      await audit({
        action: 'billing.invoice_paid',
        actorType: 'system',
        tenantId: tenant.id,
        payload: { invoice: invoice.id, amount: invoice.amount_paid },
      })
      break
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice
      const tenant = await tenantByCustomer(invoice.customer)
      if (!tenant) return

      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          status: 'PAST_DUE',
          statusReason: 'An invoice payment failed. Update your payment method to resume sending.',
        },
      })
      await audit({
        action: 'billing.payment_failed',
        actorType: 'system',
        tenantId: tenant.id,
        payload: { invoice: invoice.id },
      })
      await notifyTenant(tenant.id, 'invoiceFailed', {
        ...templates.invoiceFailed({
          organization: tenant.name,
          url: `${config.APP_URL}/t/${tenant.id}/usage`,
        }),
      })
      break
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      const tenant = await tenantByCustomer(sub.customer)
      if (!tenant) return
      await pauseTenant(tenant.id, 'Subscription cancelled', { actorType: 'system' })
      break
    }

    default:
      logger.debug({ type: event.type }, 'unhandled stripe event')
  }
}

async function tenantByCustomer(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null) {
  const id = typeof customer === 'string' ? customer : customer?.id
  if (!id) return null
  return prisma.tenant.findUnique({ where: { stripeCustomerId: id } })
}
