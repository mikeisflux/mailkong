import { prisma } from '../db.js'
import { PostalServerClient, PostalError } from '../postal/index.js'
import { decrypt } from '../lib/crypto.js'
import { badRequest, forbidden, paymentRequired } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { assertSendableFrom } from './domains.js'
import { isSuppressed } from './suppressions.js'
import { releaseSend, reserveSend } from './usage.js'
import { enqueueWebhook } from './webhooks.js'
import type { Tenant } from '@prisma/client'

export interface SendInput {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  subject: string
  html?: string
  text?: string
  tag?: string
  metadata?: Record<string, unknown>
  headers?: Record<string, string>
  attachments?: Array<{ name: string; contentType: string; data: string }>
}

export interface SendResult {
  id: string
  status: 'queued'
  /** Recipients dropped before sending because they are suppressed. */
  suppressed: string[]
}

/**
 * The control-plane send path, spec 10.
 *
 *   1. Authenticate key -> tenant + server   (done by the route)
 *   2. Enforce plan cap and daily cap
 *   3. Enforce from-domain is verified
 *   4. Drop / reject if recipient is suppressed
 *   5. Hand to Postal send API
 *   6. Persist message id mapping
 *   7. Return { id, status: "queued" }
 *
 * Steps 2-4 run before Postal is touched, so a rejected message costs one
 * database round trip rather than an SMTP transaction, and a paused tenant
 * cannot reach the sending IPs at all.
 */
export async function sendMessage(tenant: Tenant, input: SendInput): Promise<SendResult> {
  // -- gate: account status ----------------------------------------------
  assertCanSend(tenant)

  if (input.to.length === 0) throw badRequest('no_recipients', 'At least one recipient is required')
  if (input.to.length > 50) {
    throw badRequest('too_many_recipients', 'A single message may not exceed 50 recipients')
  }
  if (!input.html && !input.text) {
    throw badRequest('empty_body', 'Provide at least one of `html` or `text`')
  }

  // -- step 3: from-domain must be verified ------------------------------
  await assertSendableFrom(tenant.id, input.from)

  // -- step 4: suppression -----------------------------------------------
  const checks = await Promise.all(
    input.to.map(async (addr) => ({ addr, blocked: await isSuppressed(tenant.id, addr) })),
  )
  const suppressed = checks.filter((c) => c.blocked).map((c) => c.addr)
  const recipients = checks.filter((c) => !c.blocked).map((c) => c.addr)

  if (recipients.length === 0) {
    throw badRequest(
      'all_recipients_suppressed',
      'Every recipient is on your suppression list',
      { suppressed },
    )
  }

  // -- step 2: quota ------------------------------------------------------
  await reserveSend(tenant, recipients.length)

  // -- step 5: hand to Postal --------------------------------------------
  const server = await prisma.server.findFirst({ where: { tenantId: tenant.id } })
  if (!server) {
    await releaseSend(tenant, recipients.length)
    throw badRequest('no_server', 'This account has no mail server')
  }

  const apiKey = await serverApiKey(server.id)
  const client = new PostalServerClient(apiKey)

  let postalResult
  try {
    postalResult = await client.send({
      from: input.from,
      to: recipients,
      cc: input.cc,
      bcc: input.bcc,
      reply_to: input.replyTo,
      subject: input.subject,
      html_body: input.html,
      plain_body: input.text,
      tag: input.tag,
      headers: input.headers,
      attachments: input.attachments?.map((a) => ({
        name: a.name,
        content_type: a.contentType,
        data: a.data,
      })),
    })
  } catch (err) {
    // Quota is released so a Postal outage does not silently consume the
    // customer's allowance.
    await releaseSend(tenant, recipients.length)
    if (err instanceof PostalError) {
      logger.error({ err, tenantId: tenant.id }, 'postal send failed')
      throw badRequest('send_failed', `The mail engine rejected this message: ${err.message}`, {
        postalCode: err.code,
        retryable: err.retryable,
      })
    }
    throw err
  }

  // -- step 6: persist the thin index ------------------------------------
  const rows = Object.entries(postalResult.messages ?? {}).map(([to, ref]) => ({
    tenantId: tenant.id,
    serverId: server.id,
    postalMessageId: String(ref.id),
    token: ref.token,
    to,
    from: input.from,
    subject: input.subject,
    status: 'QUEUED' as const,
    tag: input.tag ?? null,
    metadata: (input.metadata ?? null) as never,
  }))

  const created = rows.length
    ? await prisma.message.createManyAndReturn({ data: rows })
    : []

  for (const message of created) {
    void enqueueWebhook(tenant.id, 'message.sending', {
      id: message.id,
      to: message.to,
      from: message.from,
      subject: message.subject,
      tag: message.tag,
      status: 'queued',
    })
  }

  // -- step 7 -------------------------------------------------------------
  return {
    id: created[0]?.id ?? postalResult.message_id,
    status: 'queued',
    suppressed,
  }
}

/**
 * Spec 11: a paused tenant's dashboard still loads, but sending answers 402
 * or 403 with the reason, so the customer can see what to fix.
 */
export function assertCanSend(tenant: Tenant): void {
  switch (tenant.status) {
    case 'ACTIVE':
      return
    case 'PAUSED_PENDING_DOMAIN':
      throw forbidden(
        'domain_unverified',
        tenant.statusReason ?? 'Verify a sending domain before sending mail',
      )
    case 'PAST_DUE':
      throw paymentRequired(
        'past_due',
        tenant.statusReason ?? 'Your account has an unpaid invoice. Update your payment method to resume sending.',
      )
    case 'PAUSED':
      throw forbidden('account_paused', tenant.statusReason ?? 'Sending is paused on this account')
    case 'DISABLED':
      throw forbidden('account_disabled', tenant.statusReason ?? 'This account has been disabled')
  }
}

/**
 * Postal authenticates the send API with a key scoped to the mail server,
 * which is a different secret from the customer's own API key. It is stored
 * encrypted on the server row because we must replay it to Postal.
 */
async function serverApiKey(serverId: string): Promise<string> {
  const server = await prisma.server.findUnique({ where: { id: serverId } })
  if (!server?.postalApiKeyEnc) {
    throw badRequest(
      'no_postal_credential',
      'This account has no usable mail-engine credential. Contact support.',
    )
  }
  return decrypt(server.postalApiKeyEnc)
}
