import { config } from '../config.js'
import { PostalError, PostalUnreachableError } from './errors.js'
import type {
  PostalCredential,
  PostalDomain,
  PostalIpPool,
  PostalOrganization,
  PostalQueueStats,
  PostalServer,
} from './types.js'

/**
 * Provisioning: organizations, mail servers, domains, credentials and IP
 * pools.
 *
 * IMPORTANT: none of this is in Postal's official HTTP API, which covers
 * sending and message queries only. Postal expects these objects to be
 * created through its web UI or its Rails console.
 *
 * Rather than write to Postal's MariaDB directly -- which would break on any
 * Postal upgrade and bypass its callbacks, including DKIM key generation --
 * this talks to a small companion agent running alongside Postal on Box B.
 * The agent is in `infra/postal-agent/` and executes the same model calls
 * Postal's own UI does, over an authenticated loopback-bound HTTP endpoint.
 *
 * If a future Postal release ships a first-party management API, replace the
 * transport in `call()` and the rest of this class stays as it is.
 */
export class PostalAdminClient {
  constructor(
    private readonly apiKey: string = config.POSTAL_API_KEY,
    private readonly baseUrl: string = config.POSTAL_API_URL,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/_agent/v1${path}`
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (cause) {
      throw new PostalUnreachableError(cause)
    }

    if (res.status === 404) throw new PostalError('NotFound', `Postal has no object at ${path}`, undefined, 404)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new PostalError('AgentError', `Postal agent returned HTTP ${res.status}`, text.slice(0, 500), res.status)
    }
    return (await res.json()) as T
  }

  // -- organizations (one per customer, spec 4) ---------------------------

  createOrganization(input: { name: string; permalink: string }): Promise<PostalOrganization> {
    return this.call<PostalOrganization>('POST', '/organizations', input)
  }

  deleteOrganization(permalink: string): Promise<void> {
    return this.call<void>('DELETE', `/organizations/${permalink}`)
  }

  // -- mail servers (one per product/environment) -------------------------

  createServer(input: {
    organizationPermalink: string
    name: string
    permalink: string
    mode?: 'Live' | 'Development'
    ipPoolName?: string
  }): Promise<PostalServer> {
    return this.call<PostalServer>('POST', '/servers', input)
  }

  updateServer(
    permalink: string,
    input: Partial<{
      ipPoolName: string
      sendLimit: number
      messageRetentionDays: number
      rawMessageRetentionDays: number
      spamThreshold: number
      holdOnBounce: boolean
    }>,
  ): Promise<PostalServer> {
    return this.call<PostalServer>('PATCH', `/servers/${permalink}`, input)
  }

  /** Suspending at the Postal layer backs up the tenant flag in our own DB. */
  suspendServer(permalink: string, reason: string): Promise<void> {
    return this.call<void>('POST', `/servers/${permalink}/suspend`, { reason })
  }

  unsuspendServer(permalink: string): Promise<void> {
    return this.call<void>('POST', `/servers/${permalink}/unsuspend`)
  }

  // -- domains ------------------------------------------------------------

  /** Postal generates the DKIM keypair; never invent these records. */
  createDomain(serverPermalink: string, name: string): Promise<PostalDomain> {
    return this.call<PostalDomain>('POST', `/servers/${serverPermalink}/domains`, { name })
  }

  getDomain(serverPermalink: string, name: string): Promise<PostalDomain> {
    return this.call<PostalDomain>('GET', `/servers/${serverPermalink}/domains/${encodeURIComponent(name)}`)
  }

  /** Asks Postal to re-run its own DNS checks and return fresh statuses. */
  checkDomain(serverPermalink: string, name: string): Promise<PostalDomain> {
    return this.call<PostalDomain>('POST', `/servers/${serverPermalink}/domains/${encodeURIComponent(name)}/check`)
  }

  deleteDomain(serverPermalink: string, name: string): Promise<void> {
    return this.call<void>('DELETE', `/servers/${serverPermalink}/domains/${encodeURIComponent(name)}`)
  }

  // -- credentials --------------------------------------------------------

  createCredential(
    serverPermalink: string,
    input: { type: 'API' | 'SMTP'; name: string; key?: string },
  ): Promise<PostalCredential> {
    return this.call<PostalCredential>('POST', `/servers/${serverPermalink}/credentials`, input)
  }

  deleteCredential(serverPermalink: string, id: number): Promise<void> {
    return this.call<void>('DELETE', `/servers/${serverPermalink}/credentials/${id}`)
  }

  /** Used by tenant pause: revoke sending without touching dashboard login. */
  holdAllCredentials(serverPermalink: string, hold: boolean): Promise<void> {
    return this.call<void>('POST', `/servers/${serverPermalink}/credentials/hold`, { hold })
  }

  // -- routes -------------------------------------------------------------

  createRoute(
    serverPermalink: string,
    input: { name: string; domain: string; endpointUrl: string; mode?: string },
  ): Promise<{ id: number }> {
    return this.call<{ id: number }>('POST', `/servers/${serverPermalink}/routes`, input)
  }

  deleteRoute(serverPermalink: string, id: number): Promise<void> {
    return this.call<void>('DELETE', `/servers/${serverPermalink}/routes/${id}`)
  }

  // -- IP pools (spec 5) --------------------------------------------------

  listIpPools(): Promise<PostalIpPool[]> {
    return this.call<PostalIpPool[]>('GET', '/ip_pools')
  }

  createIpPool(name: string): Promise<PostalIpPool> {
    return this.call<PostalIpPool>('POST', '/ip_pools', { name })
  }

  addIpToPool(poolName: string, input: { ipv4: string; hostname: string }): Promise<void> {
    return this.call<void>('POST', `/ip_pools/${encodeURIComponent(poolName)}/addresses`, input)
  }

  assignPoolToOrganization(poolName: string, organizationPermalink: string): Promise<void> {
    return this.call<void>('POST', `/ip_pools/${encodeURIComponent(poolName)}/organizations`, {
      organizationPermalink,
    })
  }

  // -- health (spec 9.2 Queues + health) ----------------------------------

  queueStats(): Promise<PostalQueueStats> {
    return this.call<PostalQueueStats>('GET', '/health/queue')
  }

  async reachable(): Promise<boolean> {
    try {
      await this.call('GET', '/health')
      return true
    } catch {
      return false
    }
  }
}

export const postalAdmin = new PostalAdminClient()
