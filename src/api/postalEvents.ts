import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { safeEqual, sha256 } from '../lib/crypto.js'
import { ingestPostalEvent, ingestInboundMessage, type PostalEvent } from '../services/events.js'
import { logger } from '../lib/logger.js'
import { unauthorized } from '../lib/errors.js'

/**
 * Ingress for Postal's own webhooks.
 *
 * Postal signs with its private key, but verifying that requires fetching
 * and pinning Postal's public key, and Postal is a machine we control on a
 * private path. A shared bearer derived from POSTAL_API_KEY is simpler and
 * strictly stronger than an unauthenticated endpoint. Compared in constant
 * time so the token cannot be recovered by timing.
 */
export async function postalEventRoutes(app: FastifyInstance): Promise<void> {
  const expected = sha256(`postal-events:${config.POSTAL_API_KEY}`)

  app.addHook('preHandler', async (req) => {
    const provided = String(req.headers['x-postal-token'] ?? '')
    if (!provided || !safeEqual(sha256(provided), sha256(expected))) {
      throw unauthorized('Invalid Postal event token')
    }
  })

  app.post('/events', async (req, reply) => {
    const event = req.body as PostalEvent
    if (!event?.event) {
      reply.code(400)
      return { error: 'missing event name' }
    }

    try {
      await ingestPostalEvent(event)
    } catch (err) {
      // Answer 200 regardless: Postal retries on failure, and a poison event
      // retried forever is worse than one dropped and logged.
      logger.error({ err, event: event.event }, 'failed to ingest postal event')
    }
    return { ok: true }
  })

  app.post<{ Params: { routeId: string } }>('/inbound/:routeId', async (req) => {
    const body = req.body as {
      from?: string
      to?: string
      subject?: string
      plain_body?: string
      html_body?: string
      headers?: Record<string, string>
      attachments?: unknown[]
      spam_score?: number
    }

    await ingestInboundMessage({
      routeId: req.params.routeId,
      from: body.from ?? '',
      to: body.to ?? '',
      subject: body.subject ?? '',
      plainBody: body.plain_body,
      htmlBody: body.html_body,
      headers: body.headers,
      attachments: body.attachments,
      spamScore: body.spam_score,
    })
    return { ok: true }
  })
}

/** The token Postal must present. Printed by the provisioning script. */
export const postalEventToken = () => sha256(`postal-events:${config.POSTAL_API_KEY}`)
