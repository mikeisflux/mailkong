import { prisma } from '../db.js'
import { Queue } from 'bullmq'
import { createRedis } from '../redis.js'
import { decrypt, signPayload } from '../lib/crypto.js'
import { logger } from '../lib/logger.js'

export const WEBHOOK_EVENTS = [
  'message.sending',
  'message.delivered',
  'message.bounced',
  'message.failed',
  'message.clicked',
  'message.opened',
  'inbound.message',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export interface WebhookJob {
  endpointId: string
  event: WebhookEvent
  payload: Record<string, unknown>
  /** Plaintext signing secret, held only for the life of the job. */
  secret: string
}

let queue: Queue<WebhookJob> | null = null

export function webhookQueue(): Queue<WebhookJob> {
  queue ??= new Queue<WebhookJob>('webhooks', {
    connection: createRedis({ forQueue: true }),
    defaultJobOptions: {
      // Roughly 1s, 5s, 25s, 2m, 10m. A receiver that is down for ten
      // minutes gets its events; one down for an hour does not block ours.
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: { age: 86_400 },
    },
  })
  return queue
}

/**
 * Fan an event out to every endpoint on the tenant subscribed to it.
 *
 * Callers use `void enqueueWebhook(...)` on the send path: a webhook failure
 * must never fail the customer's send.
 */
export async function enqueueWebhook(
  tenantId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { tenantId, enabled: true, events: { has: event } },
    })
    if (endpoints.length === 0) return

    await webhookQueue().addBulk(
      endpoints.map((endpoint) => ({
        name: event,
        data: {
          endpointId: endpoint.id,
          event,
          payload: { event, timestamp: new Date().toISOString(), data: payload },
          secret: decrypt(endpoint.secretEnc),
        },
      })),
    )
  } catch (err) {
    logger.error({ err, tenantId, event }, 'failed to enqueue webhook')
  }
}

/**
 * Signature over the exact bytes we transmit. Customers verify with:
 *   HMAC-SHA256(secret, rawBody) === X-Mail-Signature
 * Header name per spec 10.
 */
export function buildSignatureHeaders(secret: string, rawBody: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Mailkong-Webhook/1',
    'X-Mail-Timestamp': timestamp,
    // Timestamp is prefixed into the signed material so a captured payload
    // cannot be replayed indefinitely.
    'X-Mail-Signature': signPayload(secret, `${timestamp}.${rawBody}`),
  }
}

/** Delivers one webhook. Returns false to let BullMQ retry. */
export async function deliverWebhook(job: WebhookJob): Promise<boolean> {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: job.endpointId } })
  if (!endpoint || !endpoint.enabled) return true

  const rawBody = JSON.stringify(job.payload)
  const started = Date.now()

  let statusCode: number | null = null
  let error: string | null = null

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: buildSignatureHeaders(job.secret, rawBody),
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
    statusCode = res.status
  } catch (err) {
    error = String(err).slice(0, 500)
  }

  const latencyMs = Date.now() - started
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300

  await prisma.$transaction([
    prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        event: job.event,
        payload: job.payload as never,
        statusCode,
        latencyMs,
        error,
        succeededAt: ok ? new Date() : null,
      },
    }),
    prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: ok
        ? { lastStatus: statusCode, lastSuccessAt: new Date(), consecutiveFailures: 0 }
        : {
            lastStatus: statusCode,
            lastFailureAt: new Date(),
            consecutiveFailures: { increment: 1 },
          },
    }),
  ])

  // Spec 8.2 alerts: a persistently dead endpoint is disabled and surfaced
  // rather than retried forever.
  if (!ok && endpoint.consecutiveFailures + 1 >= 50) {
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { enabled: false },
    })
    logger.warn({ endpointId: endpoint.id }, 'webhook endpoint disabled after repeated failures')
  }

  return ok
}
