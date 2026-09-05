import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { PostalError, PostalUnreachableError } from './errors.js'
import type {
  PostalDelivery,
  PostalMessageDetail,
  PostalSendMessage,
  PostalSendResult,
} from './types.js'

/**
 * Postal's official HTTP API: sending and message queries only, scoped to a
 * single mail server by its API credential.
 *
 * Every response arrives as HTTP 200 wrapping `{ status, time, flags, data }`,
 * where `status` is "success", "parameter-error" or "error". Unwrap before
 * trusting anything.
 */
export class PostalServerClient {
  constructor(
    private readonly serverApiKey: string,
    private readonly baseUrl: string = config.POSTAL_API_URL,
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/v1/${path}`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Server-API-Key': this.serverApiKey,
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (cause) {
      throw new PostalUnreachableError(cause)
    }

    if (!res.ok) {
      throw new PostalError('HttpError', `Postal returned HTTP ${res.status}`, await safeText(res), res.status)
    }

    const envelope = (await res.json()) as {
      status: string
      data: unknown
      time?: number
    }

    if (envelope.status === 'success') return envelope.data as T

    const data = envelope.data as { code?: string; message?: string } | undefined
    throw new PostalError(
      data?.code ?? envelope.status,
      data?.message ?? `Postal rejected the request (${envelope.status})`,
      envelope.data,
      res.status,
    )
  }

  send(message: PostalSendMessage): Promise<PostalSendResult> {
    return this.call<PostalSendResult>('send/message', message)
  }

  sendRaw(input: { mail_from: string; rcpt_to: string[]; data: string }): Promise<PostalSendResult> {
    return this.call<PostalSendResult>('send/raw', {
      ...input,
      data: Buffer.from(input.data).toString('base64'),
    })
  }

  message(id: number, expansions: string[] = ['status', 'details']): Promise<PostalMessageDetail> {
    return this.call<PostalMessageDetail>('messages/message', { id, _expansions: expansions })
  }

  deliveries(id: number): Promise<PostalDelivery[]> {
    return this.call<PostalDelivery[]>('messages/deliveries', { id })
  }

  /** Cheap reachability probe for the admin System screen. */
  async ping(): Promise<boolean> {
    try {
      await this.message(0)
      return true
    } catch (err) {
      // A "NoSuchMessage" answer still proves Postal is up and the key valid.
      if (err instanceof PostalError && !err.retryable) return true
      logger.warn({ err }, 'postal ping failed')
      return false
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}
