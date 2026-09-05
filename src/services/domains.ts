import { prisma } from '../db.js'
import { config } from '../config.js'
import { postalAdmin } from '../postal/index.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { planLimits } from './usage.js'
import { audit } from './audit.js'
import { notifyTenant } from '../mail/mailer.js'
import { templates } from '../mail/templates.js'
import type { Domain } from '@prisma/client'

/** A DNS record we ask the customer to publish, rendered with copy buttons. */
export interface DnsRecord {
  type: 'TXT' | 'CNAME' | 'MX' | 'A'
  name: string
  value: string
  priority?: number
  purpose: 'spf' | 'dkim' | 'dmarc' | 'return_path' | 'tracking' | 'inbound'
  required: boolean
}

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

export async function addDomain(input: {
  tenantId: string
  name: string
  kind?: 'SENDING' | 'TRACKING' | 'INBOUND'
  actorId?: string
}): Promise<{ domain: Domain; records: DnsRecord[] }> {
  const name = input.name.trim().toLowerCase().replace(/\.$/, '')
  if (!DOMAIN_RE.test(name)) throw badRequest('invalid_domain', `"${input.name}" is not a valid domain name`)

  // Refuse the platform's own domain outright: a customer who verified
  // mailkong.net could send as us.
  if (name === config.PLATFORM_DOMAIN || name.endsWith(`.${config.PLATFORM_DOMAIN}`)) {
    throw badRequest('reserved_domain', 'That domain is reserved by the platform')
  }

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: input.tenantId },
    include: { plan: true, servers: true, domains: true },
  })

  const limits = planLimits(tenant.plan?.limits)
  if (limits.domains >= 0 && tenant.domains.length >= limits.domains) {
    throw conflict('domain_limit', `Your plan allows ${limits.domains} domains. Upgrade to add more.`)
  }
  if (tenant.domains.some((d) => d.name === name)) {
    throw conflict('domain_exists', `${name} is already on this account`)
  }

  const server = tenant.servers[0]
  if (!server?.postalPermalink) throw badRequest('no_server', 'This account has no mail server yet')

  // Postal generates the DKIM keypair. Never fabricate these values.
  const postalDomain = await postalAdmin.createDomain(server.postalPermalink, name)
  const records = buildRecords(name, postalDomain, input.kind ?? 'SENDING')

  const domain = await prisma.domain.create({
    data: {
      tenantId: input.tenantId,
      name,
      kind: input.kind ?? 'SENDING',
      postalDomainId: String(postalDomain.id),
      dnsRecords: records as never,
    },
  })

  await audit({
    action: 'domain.added',
    actorType: 'user',
    actorId: input.actorId ?? null,
    tenantId: input.tenantId,
    payload: { domain: name },
  })

  return { domain, records }
}

/**
 * Re-runs Postal's DNS checks and mirrors the result.
 *
 * Activating the tenant is a side effect on purpose: spec 14 says an account
 * stays in PAUSED_PENDING_DOMAIN until one domain verifies, and this is the
 * only place that transition can legitimately happen.
 */
export async function checkDomain(domainId: string): Promise<Domain> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    include: { tenant: { include: { servers: true } } },
  })
  if (!domain) throw notFound('Domain')

  const server = domain.tenant.servers[0]
  if (!server?.postalPermalink) throw badRequest('no_server', 'This account has no mail server')

  const result = await postalAdmin.checkDomain(server.postalPermalink, domain.name)

  const spfOk = result.spf_status === 'OK'
  const dkimOk = result.dkim_status === 'OK'
  const dmarcOk = await checkDmarc(domain.name)
  const returnPathOk = result.return_path_status === 'OK'
  const mxOk = result.mx_status === 'OK'

  // Spec 8.2: do not let them send to the public until SPF and DKIM pass.
  const verified = spfOk && dkimOk

  const updated = await prisma.domain.update({
    where: { id: domainId },
    data: {
      spfOk,
      dkimOk,
      dmarcOk,
      returnPathOk,
      mxOk,
      lastCheckedAt: new Date(),
      lastCheckOutput: [result.spf_error, result.dkim_error, result.return_path_error, result.mx_error]
        .filter(Boolean)
        .join('\n') || null,
      verifiedAt: verified ? (domain.verifiedAt ?? new Date()) : null,
      dnsRecords: buildRecords(domain.name, result, domain.kind) as never,
    },
  })

  // Newly verified, or newly broken: both are worth an email, and neither
  // should fire on every one of the two-minute re-checks.
  const wasVerified = domain.verifiedAt !== null
  if (verified && !wasVerified) {
    await notifyTenant(domain.tenantId, 'bounceSpike', {
      ...templates.domainVerified({
        domain: domain.name,
        url: `${config.APP_URL}/t/${domain.tenantId}/send`,
      }),
    })
  } else if (!verified && wasVerified) {
    await notifyTenant(domain.tenantId, 'bounceSpike', {
      ...templates.domainBroken({
        domain: domain.name,
        detail: updated.lastCheckOutput ?? 'SPF or DKIM no longer resolves',
        url: `${config.APP_URL}/t/${domain.tenantId}/domains`,
      }),
    })
  }

  if (verified && domain.tenant.status === 'PAUSED_PENDING_DOMAIN') {
    await prisma.tenant.update({
      where: { id: domain.tenantId },
      data: { status: 'ACTIVE', statusReason: null },
    })
    await audit({
      action: 'tenant.activated',
      actorType: 'system',
      tenantId: domain.tenantId,
      payload: { via: 'domain_verified', domain: domain.name },
    })
  }

  return updated
}

export async function removeDomain(domainId: string, actorId?: string): Promise<void> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    include: { tenant: { include: { servers: true, domains: true } } },
  })
  if (!domain) throw notFound('Domain')

  // Spec 8.2: blocked if it is the only verified domain and volume is queued.
  const otherVerified = domain.tenant.domains.filter((d) => d.id !== domainId && d.verifiedAt)
  if (otherVerified.length === 0) {
    const queued = await prisma.message.count({
      where: { tenantId: domain.tenantId, status: { in: ['QUEUED', 'PENDING', 'HELD'] } },
    })
    if (queued > 0) {
      throw conflict(
        'domain_in_use',
        `${queued} message(s) are still queued and this is your only verified domain.`,
      )
    }
  }

  const server = domain.tenant.servers[0]
  if (server?.postalPermalink) {
    await postalAdmin.deleteDomain(server.postalPermalink, domain.name).catch(() => undefined)
  }
  await prisma.domain.delete({ where: { id: domainId } })
  await audit({
    action: 'domain.removed',
    actorType: 'user',
    actorId: actorId ?? null,
    tenantId: domain.tenantId,
    payload: { domain: domain.name },
  })
}

/** Is this From address allowed? Spec 10 step 3, spec 14. */
export async function assertSendableFrom(tenantId: string, fromAddress: string): Promise<void> {
  const domain = extractDomain(fromAddress)
  if (!domain) throw badRequest('invalid_from', `Could not parse a domain from "${fromAddress}"`)

  const record = await prisma.domain.findFirst({
    where: { tenantId, name: domain, kind: 'SENDING' },
  })
  if (!record) {
    throw badRequest('domain_not_added', `${domain} is not a sending domain on this account`)
  }
  if (!record.verifiedAt) {
    throw badRequest(
      'domain_not_verified',
      `${domain} has not passed SPF and DKIM checks yet. Publish the DNS records and re-check.`,
      { spf: record.spfOk, dkim: record.dkimOk, dmarc: record.dmarcOk },
    )
  }
}

export function extractDomain(address: string): string | null {
  const match = /<([^>]+)>\s*$/.exec(address.trim())
  const bare = (match?.[1] ?? address).trim()
  const at = bare.lastIndexOf('@')
  if (at === -1) return null
  return bare.slice(at + 1).toLowerCase() || null
}

function buildRecords(
  name: string,
  postal: { dkim_record?: string; dkim_record_name?: string; spf_record?: string; return_path_record?: string },
  kind: string,
): DnsRecord[] {
  const platform = config.PLATFORM_DOMAIN
  const records: DnsRecord[] = [
    {
      type: 'TXT',
      name,
      value: postal.spf_record ?? `v=spf1 include:spf.${platform} ~all`,
      purpose: 'spf',
      required: true,
    },
    {
      type: 'TXT',
      name: postal.dkim_record_name ? `${postal.dkim_record_name}.${name}` : `postal._domainkey.${name}`,
      value: postal.dkim_record ?? '',
      purpose: 'dkim',
      required: true,
    },
    {
      type: 'TXT',
      name: `_dmarc.${name}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${platform}`,
      purpose: 'dmarc',
      required: false,
    },
    {
      type: 'CNAME',
      name: `psrp.${name}`,
      value: postal.return_path_record ?? `rp.${platform}`,
      purpose: 'return_path',
      required: false,
    },
  ]

  if (kind === 'TRACKING') {
    records.push({
      type: 'CNAME',
      name: `track.${name}`,
      value: `track.${platform}`,
      purpose: 'tracking',
      required: true,
    })
  }
  if (kind === 'INBOUND') {
    records.push({
      type: 'MX',
      name: `inbound.${name}`,
      value: `routes.${platform}`,
      priority: 10,
      purpose: 'inbound',
      required: true,
    })
  }
  return records
}

/** Postal does not check DMARC, so we resolve it ourselves. */
async function checkDmarc(name: string): Promise<boolean> {
  try {
    const { resolveTxt } = await import('node:dns/promises')
    const records = await resolveTxt(`_dmarc.${name}`)
    return records.some((chunks) => chunks.join('').toLowerCase().startsWith('v=dmarc1'))
  } catch {
    return false
  }
}
