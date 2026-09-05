import Stripe from 'stripe'
import { config } from '../config.js'

let client: Stripe | null | undefined

/**
 * Stripe is optional in development and for the internal tenant, so every
 * call site must tolerate null rather than assume billing is configured.
 */
export function getStripe(): Stripe | null {
  if (client !== undefined) return client
  client = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' }) : null
  return client
}
