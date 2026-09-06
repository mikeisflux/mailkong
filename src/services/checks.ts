import { Resolver } from 'node:dns/promises'
import { connect as tlsConnect } from 'node:tls'
import { prisma } from '../db.js'
import { logger } from '../lib/logger.js'
import { config } from '../config.js'

/**
 * The operational checks in spec 9.2: are our sending IPs listed, are our
 * certificates about to expire, and can each IP actually reach the internet.
 *
 * All three answer questions an operator would otherwise resolve by hand at
 * the worst possible moment.
 */

/**
 * DNSBLs we check against, and how much each one matters.
 *
 * Spamhaus ZEN is the one that stops mail. The others are advisory: a listing
 * there is worth knowing about but rarely worth paging anyone.
 */
export const BLOCKLISTS = [
  { zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN', severity: 'critical' as const },
  { zone: 'b.barracudacentral.org', name: 'Barracuda', severity: 'warning' as const },
  { zone: 'bl.spamcop.net', name: 'SpamCop', severity: 'warning' as const },
  { zone: 'dnsbl.sorbs.net', name: 'SORBS', severity: 'info' as const },
]

export interface BlocklistResult {
  zone: string
  name: string
  severity: 'critical' | 'warning' | 'info'
  listed: boolean
  answer: string | null
  /** False when the lookup did not produce a trustworthy answer. */
  usable: boolean
}

/**
 * Every major DNSBL refuses queries from public resolvers -- Spamhaus in
 * particular returns NXDOMAIN rather than an error when queried through
 * 8.8.8.8 or 1.1.1.1. NXDOMAIN is also how "not listed" is expressed, so a
 * blocked resolver reports every address as clean. That is the worst possible
 * failure: silent, and reassuring.
 *
 * `2.0.0.127` is the address every DNSBL guarantees to list, so querying it
 * proves the zone is answering us truthfully. If the sentinel comes back
 * clean, the resolver is being refused and no result from that zone means
 * anything.
 */
const SENTINEL_IP = '127.0.0.2'

async function zoneIsAnswering(resolver: Resolver, zone: string): Promise<boolean> {
  try {
    const answers = await resolver.resolve4(`${reverseOctets(SENTINEL_IP)}.${zone}`)
    return answers.length > 0
  } catch {
    return false
  }
}

function reverseOctets(ip: string): string {
  return ip.split('.').reverse().join('.')
}

/**
 * A DNSBL lookup is a plain A-record query for <reversed-ip>.<zone>; an answer
 * means listed, NXDOMAIN means clean.
 *
 * Uses a resolver with a short timeout rather than the default: a DNSBL that
 * stops answering must not stall the whole sweep.
 */
export async function checkBlocklists(ip: string): Promise<BlocklistResult[]> {
  const resolver = new Resolver({ timeout: 4000, tries: 1 })

  return Promise.all(
    BLOCKLISTS.map(async (list) => {
      try {
        const answers = await resolver.resolve4(`${reverseOctets(ip)}.${list.zone}`)
        return { ...list, listed: answers.length > 0, answer: answers[0] ?? null, usable: true }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code

        if (code === 'ENOTFOUND' || code === 'ENODATA') {
          // NXDOMAIN means "not listed" only if this zone is actually
          // answering us. Prove that before believing it.
          const answering = await zoneIsAnswering(resolver, list.zone)
          return answering
            ? { ...list, listed: false, answer: null, usable: true }
            : {
                ...list,
                listed: false,
                usable: false,
                answer: 'this resolver is refused by the zone — result is not meaningful',
              }
        }

        logger.debug({ err, ip, zone: list.zone }, 'blocklist lookup failed')
        return { ...list, listed: false, answer: `lookup failed: ${code ?? 'unknown'}`, usable: false }
      }
    }),
  )
}

export async function sweepBlocklists(): Promise<{ checked: number; listed: number; unusable: number }> {
  const addresses = await prisma.ipAddress.findMany()
  let listed = 0
  let unusable = 0

  for (const address of addresses) {
    const results = await checkBlocklists(address.address)
    const bad = results.filter((r) => r.listed)
    if (results.some((r) => !r.usable)) unusable++

    if (bad.length > 0) {
      listed++
      logger.error(
        { ip: address.address, lists: bad.map((b) => b.name) },
        'sending IP is listed on a blocklist',
      )
    }

    await prisma.ipAddress.update({
      where: { id: address.id },
      data: { lastBlacklistCheckAt: new Date(), blacklistStatus: results as never },
    })
  }

  if (unusable > 0) {
    logger.warn(
      { unusable },
      'some blocklist zones refused this resolver. Box A must use a local recursive resolver ' +
        '(unbound, or systemd-resolved with DNSSEC), not a public one -- Spamhaus and others ' +
        'return NXDOMAIN to 8.8.8.8 and 1.1.1.1, which reads as "clean".',
    )
  }

  return { checked: addresses.length, listed, unusable }
}

// ------------------------------------------------------------ certificates

export interface CertResult {
  host: string
  port: number
  ok: boolean
  expiresAt: string | null
  daysRemaining: number | null
  issuer: string | null
  error: string | null
}

/**
 * Spec 9.2: "Certificate expiry on smtp / api / app".
 *
 * Checked from outside rather than by reading files on disk, because that is
 * what a customer's client sees -- a renewed certificate that nginx never
 * reloaded still serves the old one.
 */
export async function checkCertificate(host: string, port = 443): Promise<CertResult> {
  return new Promise((resolve) => {
    const socket = tlsConnect(
      {
        host,
        port,
        servername: host,
        // Report on an invalid chain rather than refusing to look at it.
        rejectUnauthorized: false,
        timeout: 6000,
      },
      () => {
        const cert = socket.getPeerCertificate()
        socket.end()

        if (!cert || !cert.valid_to) {
          resolve({ host, port, ok: false, expiresAt: null, daysRemaining: null, issuer: null, error: 'no certificate presented' })
          return
        }

        const expires = new Date(cert.valid_to)
        const days = Math.floor((expires.getTime() - Date.now()) / 86_400_000)
        resolve({
          host,
          port,
          ok: socket.authorized && days > 0,
          expiresAt: expires.toISOString(),
          daysRemaining: days,
          // Node types issuer fields as string | string[] depending on the cert.
          issuer: Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] ?? null : cert.issuer?.O ?? null,
          error: socket.authorized ? null : (socket.authorizationError as unknown as string) ?? null,
        })
      },
    )

    socket.on('timeout', () => {
      socket.destroy()
      resolve({ host, port, ok: false, expiresAt: null, daysRemaining: null, issuer: null, error: 'timed out' })
    })
    socket.on('error', (err) => {
      resolve({ host, port, ok: false, expiresAt: null, daysRemaining: null, issuer: null, error: err.message })
    })
  })
}

export function monitoredHosts(): Array<{ host: string; port: number }> {
  const platform = config.PLATFORM_DOMAIN
  return [
    { host: new URL(config.APP_URL).hostname, port: 443 },
    { host: new URL(config.API_URL).hostname, port: 443 },
    { host: new URL(config.ADMIN_URL).hostname, port: 443 },
    { host: config.POSTAL_SMTP_HOST, port: 587 },
    { host: `postal.${platform}`, port: 443 },
  ]
}

export async function checkAllCertificates(): Promise<CertResult[]> {
  return Promise.all(monitoredHosts().map((h) => checkCertificate(h.host, h.port)))
}

// -------------------------------------------------------------- outbound

export interface OutboundTest {
  ip: string
  ptr: string | null
  ptrMatches: boolean | null
  forwardConfirmed: boolean | null
  error: string | null
}

/**
 * Spec 9.2 System: "Outbound test from each sending IP".
 *
 * Verifies the property that actually governs deliverability: forward-confirmed
 * reverse DNS. Gmail and Microsoft defer mail whose PTR does not resolve back
 * to the sending address, and a PTR that was correct on provisioning day can
 * be silently wrong after an IP is reassigned.
 */
export async function testSendingIp(ip: string, expectedPtr: string | null): Promise<OutboundTest> {
  const resolver = new Resolver({ timeout: 5000, tries: 2 })

  try {
    const names = await resolver.reverse(ip)
    const ptr = names[0] ?? null
    if (!ptr) {
      return { ip, ptr: null, ptrMatches: false, forwardConfirmed: false, error: 'no PTR record' }
    }

    const forward = await resolver.resolve4(ptr).catch(() => [] as string[])
    return {
      ip,
      ptr,
      ptrMatches: expectedPtr ? ptr.toLowerCase() === expectedPtr.toLowerCase() : null,
      forwardConfirmed: forward.includes(ip),
      error: null,
    }
  } catch (err) {
    return {
      ip,
      ptr: null,
      ptrMatches: false,
      forwardConfirmed: false,
      error: (err as Error).message,
    }
  }
}

export async function testAllSendingIps(): Promise<OutboundTest[]> {
  const addresses = await prisma.ipAddress.findMany()
  return Promise.all(addresses.map((a) => testSendingIp(a.address, a.ptr)))
}
