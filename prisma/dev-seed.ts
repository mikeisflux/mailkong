/**
 * Development fixture: a tenant with verified domains, credentials, messages
 * and usage history, created WITHOUT calling Postal.
 *
 * Provisioning normally goes through Postal (see services/provisioning.ts).
 * This bypasses it so the dashboard and admin console can be worked on
 * before Box B exists.
 */
import { PrismaClient } from '@prisma/client'
import argon2 from 'argon2'
import { randomBytes, createCipheriv, createHash } from 'node:crypto'

const prisma = new PrismaClient()

function encrypt(plain: string): string {
  const key = createHash('sha256').update(process.env.ENCRYPTION_KEY!).digest()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.')
}

const SUBJECTS = ['Your receipt', 'Password reset', 'Order #4821 shipped', 'Welcome to Acme', 'Your invoice is ready', 'Security alert: new sign-in']
const STATUSES = ['DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'SENT', 'BOUNCED', 'FAILED', 'QUEUED'] as const

async function main() {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { key: 'growth' } })

  const user = await prisma.user.upsert({
    where: { email: 'dev@mailkong.net' },
    create: {
      email: 'dev@mailkong.net',
      name: 'Dev User',
      passwordHash: await argon2.hash('devpassword1234', { type: argon2.argon2id }),
    },
    update: {},
  })

  await prisma.tenant.deleteMany({ where: { slug: 'acme-commerce' } })

  const tenant = await prisma.tenant.create({
    data: {
      name: 'Acme Commerce',
      slug: 'acme-commerce',
      planId: plan.id,
      status: 'ACTIVE',
      dailyCap: 5000,
      postalOrgId: 'acme-commerce',
      memberships: { create: { userId: user.id, role: 'OWNER' } },
      notificationPrefs: { create: { emails: [user.email] } },
      subscription: {
        create: {
          planId: plan.id,
          periodStart: new Date(Date.now() - 12 * 86_400_000),
          periodEnd: new Date(Date.now() + 18 * 86_400_000),
          sendsUsed: 214_800,
        },
      },
    },
  })

  const server = await prisma.server.create({
    data: {
      tenantId: tenant.id,
      name: 'Production',
      postalPermalink: 'acme-commerce/production',
      postalApiKeyEnc: encrypt('dev-postal-key'),
      retentionDays: 30,
    },
  })

  await prisma.domain.createMany({
    data: [
      {
        tenantId: tenant.id,
        name: 'acmecommerce.com',
        kind: 'SENDING',
        spfOk: true, dkimOk: true, dmarcOk: true, returnPathOk: true,
        verifiedAt: new Date(),
        lastCheckedAt: new Date(Date.now() - 4 * 60_000),
        dnsRecords: [
          { type: 'TXT', name: 'acmecommerce.com', value: 'v=spf1 include:spf.mailkong.net ~all', purpose: 'spf', required: true },
          { type: 'TXT', name: 'postal._domainkey.acmecommerce.com', value: 'v=DKIM1; t=s; h=sha256; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7...', purpose: 'dkim', required: true },
          { type: 'TXT', name: '_dmarc.acmecommerce.com', value: 'v=DMARC1; p=none; rua=mailto:dmarc@mailkong.net', purpose: 'dmarc', required: false },
          { type: 'CNAME', name: 'psrp.acmecommerce.com', value: 'rp.mailkong.net', purpose: 'return_path', required: false },
        ],
      },
      {
        tenantId: tenant.id,
        name: 'acme-staging.com',
        kind: 'SENDING',
        spfOk: true, dkimOk: false, dmarcOk: false, returnPathOk: false,
        lastCheckedAt: new Date(Date.now() - 90_000),
        lastCheckOutput: 'DKIM record not found at postal._domainkey.acme-staging.com',
        dnsRecords: [
          { type: 'TXT', name: 'acme-staging.com', value: 'v=spf1 include:spf.mailkong.net ~all', purpose: 'spf', required: true },
          { type: 'TXT', name: 'postal._domainkey.acme-staging.com', value: 'v=DKIM1; t=s; h=sha256; p=MIGfMA0GCSqGSIb3DQ...', purpose: 'dkim', required: true },
        ],
      },
    ],
  })

  await prisma.credential.createMany({
    data: [
      { tenantId: tenant.id, serverId: server.id, kind: 'API_KEY', name: 'production-api', prefix: 'pk_live_a1b2c3d4', secretHash: 'x', lastUsedAt: new Date(Date.now() - 120_000) },
      { tenantId: tenant.id, serverId: server.id, kind: 'API_KEY', name: 'staging-api', prefix: 'pk_live_9z8y7x6w', secretHash: 'x', lastUsedAt: new Date(Date.now() - 3 * 86_400_000) },
      { tenantId: tenant.id, serverId: server.id, kind: 'SMTP', name: 'wordpress', prefix: 'acme-commerce/wordpress', secretHash: 'x' },
    ],
  })

  const webhook = await prisma.webhookEndpoint.create({
    data: {
      tenantId: tenant.id,
      url: 'https://acmecommerce.com/hooks/mailkong',
      events: ['message.delivered', 'message.bounced', 'message.failed'],
      secretEnc: encrypt('whsec_devsecret'),
      lastStatus: 200,
      lastSuccessAt: new Date(Date.now() - 45_000),
    },
  })

  await prisma.webhookDelivery.createMany({
    data: Array.from({ length: 6 }, (_, i) => ({
      endpointId: webhook.id,
      event: i % 3 === 0 ? 'message.bounced' : 'message.delivered',
      payload: {},
      statusCode: i === 4 ? 502 : 200,
      latencyMs: 40 + Math.round(Math.random() * 180),
      succeededAt: i === 4 ? null : new Date(Date.now() - i * 90_000),
      createdAt: new Date(Date.now() - i * 90_000),
    })),
  })

  await prisma.inboundRoute.create({
    data: {
      tenantId: tenant.id,
      serverId: server.id,
      address: 'support',
      domain: 'inbound.acmecommerce.com',
      endpointUrl: 'https://acmecommerce.com/hooks/inbound',
    },
  })

  await prisma.suppression.createMany({
    data: [
      { tenantId: tenant.id, email: 'bounced@example.org', reason: 'HARD_BOUNCE', detail: '550 5.1.1 User unknown', createdAt: new Date(Date.now() - 2 * 86_400_000) },
      { tenantId: tenant.id, email: 'complained@example.net', reason: 'COMPLAINT', createdAt: new Date(Date.now() - 5 * 86_400_000) },
      { tenantId: tenant.id, email: 'do-not-mail@example.com', reason: 'MANUAL', createdAt: new Date(Date.now() - 9 * 86_400_000) },
    ],
  })

  // Messages across the last 30 days, weighted toward recent.
  const messages = []
  for (let i = 0; i < 260; i++) {
    const daysAgo = Math.floor(Math.abs(Math.sin(i * 1.7)) * 29)
    const created = new Date(Date.now() - daysAgo * 86_400_000 - Math.random() * 86_400_000)
    const status = STATUSES[i % STATUSES.length]!
    messages.push({
      tenantId: tenant.id,
      serverId: server.id,
      postalMessageId: String(90_000 + i),
      to: `customer${i % 47}@example.${['org', 'com', 'net'][i % 3]}`,
      from: 'Billing <billing@acmecommerce.com>',
      subject: SUBJECTS[i % SUBJECTS.length]!,
      status,
      tag: ['receipt', 'password-reset', 'shipping', 'welcome'][i % 4]!,
      bounceReason: status === 'BOUNCED' ? '550 5.1.1 <recipient> Recipient address rejected: User unknown in virtual mailbox table' : null,
      deliveredAt: status === 'DELIVERED' ? created : null,
      createdAt: created,
    })
  }
  await prisma.message.createMany({ data: messages })

  // Usage rollups
  for (let d = 0; d < 30; d++) {
    const day = new Date(Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - d,
    ))
    const sent = 4200 + Math.round(Math.sin(d / 3) * 1800 + Math.random() * 900)
    const bounced = Math.round(sent * (d === 6 ? 0.061 : 0.011))
    await prisma.usageDay.upsert({
      where: { tenantId_day: { tenantId: tenant.id, day } },
      create: {
        tenantId: tenant.id, day, sent,
        delivered: sent - bounced - 12, bounced, failed: 12,
        hardBounced: Math.round(bounced * 0.7), complained: d % 9 === 0 ? 2 : 0, held: 0,
      },
      update: {},
    })
  }

  await prisma.abuseTicket.create({
    data: {
      source: 'fbl',
      subject: 'Complaint from Microsoft FBL',
      raw: 'Feedback-Type: abuse\nUser-Agent: Microsoft SNDS\nOriginal-Rcpt-To: complained@example.net',
      status: 'NEW',
      tenantId: tenant.id,
    },
  })

  console.log(`Dev fixture ready.
  Dashboard: dev@mailkong.net / devpassword1234
  Tenant:    ${tenant.id} (Acme Commerce)`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
