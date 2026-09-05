import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../server.js'
import { prisma } from '../db.js'
import { disconnectRedis } from '../redis.js'
import { encrypt, generateApiKey, hashSecret, sha256 } from '../lib/crypto.js'

/**
 * Tenant isolation.
 *
 * The single property this platform cannot get wrong: one customer must not
 * be able to read or change another's data, whether they authenticate with an
 * API key or a dashboard session, and whether they attack by guessing an id
 * or by pointing a valid session at somebody else's tenant path.
 */

let app: Awaited<ReturnType<typeof buildServer>>

interface Party {
  tenantId: string
  userId: string
  apiKey: string
  sessionCookie: string
  domainId: string
  credentialId: string
  messageId: string
  webhookId: string
}

async function makeParty(label: string): Promise<Party> {
  const slug = `iso-${label}-${Math.random().toString(36).slice(2, 8)}`
  const plan = await prisma.plan.findUniqueOrThrow({ where: { key: 'growth' } })

  const user = await prisma.user.create({
    data: { email: `${slug}@example.org`, passwordHash: await hashSecret('a-long-password-here') },
  })

  const tenant = await prisma.tenant.create({
    data: {
      name: slug, slug, planId: plan.id, status: 'ACTIVE', dailyCap: 1000,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  })

  const server = await prisma.server.create({
    data: {
      tenantId: tenant.id, name: 'Production',
      postalPermalink: `${slug}/production`, postalApiKeyEnc: encrypt('k'),
    },
  })

  const { key, prefix } = generateApiKey()
  const credential = await prisma.credential.create({
    data: {
      tenantId: tenant.id, serverId: server.id, kind: 'API_KEY',
      name: 'test', prefix, secretHash: await hashSecret(key),
    },
  })

  const domain = await prisma.domain.create({
    data: {
      tenantId: tenant.id, name: `${slug}.example`, kind: 'SENDING',
      spfOk: true, dkimOk: true, verifiedAt: new Date(),
    },
  })

  const message = await prisma.message.create({
    data: {
      tenantId: tenant.id, serverId: server.id,
      to: `secret-recipient-${slug}@example.org`,
      from: `billing@${slug}.example`, subject: `Private to ${slug}`, status: 'DELIVERED',
    },
  })

  const webhook = await prisma.webhookEndpoint.create({
    data: { tenantId: tenant.id, url: `https://${slug}.example/hook`, secretEnc: encrypt('s'), events: ['message.delivered'] },
  })

  const token = `sess-${slug}`
  await prisma.session.create({
    data: { id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) },
  })

  return {
    tenantId: tenant.id, userId: user.id, apiKey: key,
    sessionCookie: `mk_session=${token}`,
    domainId: domain.id, credentialId: credential.id,
    messageId: message.id, webhookId: webhook.id,
  }
}

let alice: Party
let mallory: Party

describe('tenant isolation', () => {
  before(async () => {
    app = await buildServer()
    await app.ready()
    alice = await makeParty('alice')
    mallory = await makeParty('mallory')
  })

  after(async () => {
    await app.close()
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: 'iso-' } } })
    await prisma.user.deleteMany({ where: { email: { startsWith: 'iso-' } } })
    await prisma.$disconnect()
    disconnectRedis()
  })

  const asKey = (p: Party, url: string, method = 'GET') =>
    app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${p.apiKey}` } })

  const asSession = (p: Party, url: string, method = 'GET', payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie: p.sessionCookie }, payload: payload as never })

  // ------------------------------------------------------------- API keys

  test("an API key lists only its own tenant's messages", async () => {
    const res = await asKey(mallory, '/v1/messages')
    assert.equal(res.statusCode, 200)

    const body = res.json() as { data: Array<{ id: string; to: string }> }
    assert.ok(
      body.data.every((m) => !m.to.includes('alice')),
      "mallory's listing must not contain alice's recipients",
    )
  })

  test("an API key cannot fetch another tenant's message by id", async () => {
    const own = await asKey(alice, `/v1/messages/${alice.messageId}`)
    assert.equal(own.statusCode, 200, 'sanity: alice can read her own')

    const stolen = await asKey(mallory, `/v1/messages/${alice.messageId}`)
    assert.equal(stolen.statusCode, 404, 'a known id must not leak across tenants')
  })

  test("an API key cannot retry another tenant's message", async () => {
    const res = await asKey(mallory, `/v1/messages/${alice.messageId}/retry`, 'POST')
    assert.equal(res.statusCode, 404)
  })

  test("an API key cannot verify or delete another tenant's domain", async () => {
    const verify = await asKey(mallory, `/v1/domains/${alice.domainId}/verify`, 'POST')
    assert.equal(verify.statusCode, 404)

    const remove = await asKey(mallory, `/v1/domains/${alice.domainId}`, 'DELETE')
    assert.equal(remove.statusCode, 404)

    const still = await prisma.domain.findUnique({ where: { id: alice.domainId } })
    assert.ok(still, "alice's domain must survive")
  })

  test("an API key cannot revoke another tenant's credential", async () => {
    const res = await asKey(mallory, `/v1/credentials/${alice.credentialId}`, 'DELETE')
    assert.notEqual(res.statusCode, 204)

    const credential = await prisma.credential.findUnique({ where: { id: alice.credentialId } })
    assert.equal(credential?.revokedAt, null, "alice's key must still work")
  })

  test("an API key cannot delete another tenant's webhook endpoint", async () => {
    const res = await asKey(mallory, `/v1/webhooks/${alice.webhookId}`, 'DELETE')
    assert.equal(res.statusCode, 404)
    assert.ok(await prisma.webhookEndpoint.findUnique({ where: { id: alice.webhookId } }))
  })

  test('a revoked API key stops working immediately', async () => {
    const victim = await makeParty('revoked')
    const before = await asKey(victim, '/v1/domains')
    assert.equal(before.statusCode, 200)

    await prisma.credential.update({
      where: { id: victim.credentialId },
      data: { revokedAt: new Date() },
    })

    const after = await asKey(victim, '/v1/domains')
    assert.equal(after.statusCode, 401)
  })

  // ------------------------------------------------------- dashboard sessions

  test('a valid session cannot be pointed at another tenant', async () => {
    const own = await asSession(alice, `/_app/t/${alice.tenantId}/overview`)
    assert.equal(own.statusCode, 200, 'sanity: alice can read her own overview')

    const stolen = await asSession(mallory, `/_app/t/${alice.tenantId}/overview`)
    assert.equal(stolen.statusCode, 403)
    assert.equal(stolen.json().error.code, 'not_a_member')
  })

  test("a session cannot read another tenant's activity, credentials or team", async () => {
    for (const path of ['activity', 'credentials', 'team', 'usage', 'settings', 'webhooks']) {
      const res = await asSession(mallory, `/_app/t/${alice.tenantId}/${path}`)
      assert.equal(res.statusCode, 403, `${path} must be refused`)
    }
  })

  test("a session cannot mint a credential inside another tenant", async () => {
    const res = await asSession(mallory, `/_app/t/${alice.tenantId}/credentials`, 'POST', {
      kind: 'API_KEY',
      name: 'stolen',
    })
    assert.equal(res.statusCode, 403)

    const count = await prisma.credential.count({ where: { tenantId: alice.tenantId } })
    assert.equal(count, 1, 'no credential may be created in a tenant you do not belong to')
  })

  test("a session cannot close another tenant's account", async () => {
    const res = await asSession(mallory, `/_app/t/${alice.tenantId}/settings/close`, 'POST', { confirm: true })
    assert.equal(res.statusCode, 403)

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: alice.tenantId } })
    assert.equal(tenant.status, 'ACTIVE')
  })

  // ------------------------------------------------------------ admin surface

  test('the admin console is unreachable with a customer session', async () => {
    for (const path of ['/_admin/overview', '/_admin/tenants', '/_admin/audit']) {
      const res = await asSession(alice, path)
      assert.equal(res.statusCode, 401, `${path} must not accept a customer session`)
    }
  })

  test('the admin console is unreachable with a customer API key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_admin/tenants',
      headers: { authorization: `Bearer ${alice.apiKey}` },
    })
    assert.equal(res.statusCode, 401)
  })

  // ---------------------------------------------------------- suppressions

  test('suppressions do not leak between tenants', async () => {
    await prisma.suppression.create({
      data: { tenantId: alice.tenantId, email: 'alice-only@example.org', reason: 'HARD_BOUNCE' },
    })

    const res = await asKey(mallory, '/v1/suppressions')
    const body = res.json() as { data: Array<{ email: string }> }
    assert.ok(
      !body.data.some((s) => s.email === 'alice-only@example.org'),
      "mallory must not see alice's suppressed addresses",
    )
  })
})
