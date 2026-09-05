import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../db.js'
import { notFound } from '../../lib/errors.js'
import { sendMessage } from '../../services/send.js'
import { paginate, tenantOf } from '../context.js'

const address = z.string().email().or(z.string().regex(/^.+<[^@]+@[^>]+>$/, 'Expected "Name <email@domain>"'))

const sendSchema = z.object({
  from: address,
  to: z.union([address, z.array(address).min(1).max(50)]),
  cc: z.array(address).max(50).optional(),
  bcc: z.array(address).max(50).optional(),
  reply_to: address.optional(),
  subject: z.string().min(1).max(998),
  html: z.string().max(5_000_000).optional(),
  text: z.string().max(5_000_000).optional(),
  tag: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
  attachments: z
    .array(z.object({ name: z.string(), content_type: z.string(), data: z.string() }))
    .max(10)
    .optional(),
})

const listSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().optional(),
  status: z.enum(['queued', 'pending', 'sent', 'delivered', 'bounced', 'failed', 'held']).optional(),
  to: z.string().optional(),
  tag: z.string().optional(),
  from_date: z.coerce.date().optional(),
  to_date: z.coerce.date().optional(),
})

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.post('/messages', async (req) => {
    const body = sendSchema.parse(req.body)
    const tenant = tenantOf(req)

    const result = await sendMessage(tenant, {
      from: body.from,
      to: Array.isArray(body.to) ? body.to : [body.to],
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.reply_to,
      subject: body.subject,
      html: body.html,
      text: body.text,
      tag: body.tag,
      metadata: body.metadata,
      headers: body.headers,
      attachments: body.attachments?.map((a) => ({
        name: a.name,
        contentType: a.content_type,
        data: a.data,
      })),
    })

    return { id: result.id, status: result.status, suppressed: result.suppressed }
  })

  app.get('/messages', async (req) => {
    const q = listSchema.parse(req.query)
    const tenant = tenantOf(req)

    const rows = await prisma.message.findMany({
      where: {
        tenantId: tenant.id,
        ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
        ...(q.to ? { to: { contains: q.to, mode: 'insensitive' } } : {}),
        ...(q.tag ? { tag: q.tag } : {}),
        ...(q.from_date || q.to_date
          ? { createdAt: { ...(q.from_date ? { gte: q.from_date } : {}), ...(q.to_date ? { lte: q.to_date } : {}) } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    })

    return paginate(rows.map(serialize), q.limit)
  })

  app.get<{ Params: { id: string } }>('/messages/:id', async (req) => {
    const tenant = tenantOf(req)
    const message = await prisma.message.findFirst({
      where: { id: req.params.id, tenantId: tenant.id },
    })
    if (!message) throw notFound('Message')
    return serialize(message)
  })

  /**
   * Retry is a fresh send of the same envelope rather than a Postal-side
   * requeue: Postal has already given up, and the customer's suppression
   * list may have changed since.
   */
  app.post<{ Params: { id: string } }>('/messages/:id/retry', async (req) => {
    const tenant = tenantOf(req)
    const message = await prisma.message.findFirst({
      where: { id: req.params.id, tenantId: tenant.id },
    })
    if (!message) throw notFound('Message')

    const result = await sendMessage(tenant, {
      from: message.from,
      to: [message.to],
      subject: message.subject ?? '(no subject)',
      text: '(retried message: original body is held in the mail engine)',
      tag: message.tag ?? undefined,
      metadata: (message.metadata as Record<string, unknown>) ?? undefined,
    })
    return { id: result.id, status: result.status, retried_from: message.id }
  })
}

function serialize(m: {
  id: string
  to: string
  from: string
  subject: string | null
  status: string
  tag: string | null
  metadata: unknown
  bounceReason: string | null
  deliveredAt: Date | null
  createdAt: Date
}) {
  return {
    id: m.id,
    to: m.to,
    from: m.from,
    subject: m.subject,
    status: m.status.toLowerCase(),
    tag: m.tag,
    metadata: m.metadata ?? {},
    bounce_reason: m.bounceReason,
    delivered_at: m.deliveredAt?.toISOString() ?? null,
    created_at: m.createdAt.toISOString(),
  }
}
