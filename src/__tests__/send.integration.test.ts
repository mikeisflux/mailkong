import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../db.js'
import { getRedis, disconnectRedis } from '../redis.js'
import { encrypt } from '../lib/crypto.js'
import { sendMessage } from '../services/send.js'
import { suppress } from '../services/suppressions.js'
import { ApiError } from '../lib/errors.js'
import type { Tenant } from '@prisma/client'

/**
 * Exercises the spec 10 send pipeline end to end against a real Postgres and
 * Redis, with only Postal's HTTP boundary stubbed. The ordering assertions
 * matter as much as the outcomes: a cap that is checked after Postal has
 * already accepted the message is not a cap.
 */

const realFetch = globalThis.fetch
let postalCalls: Array<{ url: string; body: unknown }> = []

function stubPostal(response: 'success' | 'error' = 'success') {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    postalCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    if (response === 'error') {
      return new Response(
        JSON.stringify({ status: 'error', data: { code: 'ValidationError', message: 'nope' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { to?: string[] }
    return new Response(
      JSON.stringify({
        status: 'success',
        data: {
          message_id: 'msg-abc@mailkong.net',
          messages: Object.fromEntries(
            (body.to ?? []).map((addr, i) => [addr, { id: 1000 + i, token: `tok${i}` }]),
          ),
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
}

let tenant: Tenant

async function seedTenant(overrides: Partial<{ dailyCap: number; status: Tenant['status'] }> = {}) {
  const slug = `test-${Math.random().toString(36).slice(2, 10)}`
  const plan = await prisma.plan.findUniqueOrThrow({ where: { key: 'starter' } })

  const t = await prisma.tenant.create({
    data: {
      name: slug,
      slug,
      planId: plan.id,
      status: overrides.status ?? 'ACTIVE',
      dailyCap: overrides.dailyCap ?? 100,
      postalOrgId: slug,
    },
  })

  await prisma.server.create({
    data: {
      tenantId: t.id,
      name: 'Production',
      postalPermalink: `${slug}/production`,
      postalApiKeyEnc: encrypt('postal-server-key'),
    },
  })

  await prisma.domain.create({
    data: {
      tenantId: t.id,
      name: 'shop.example',
      kind: 'SENDING',
      spfOk: true,
      dkimOk: true,
      verifiedAt: new Date(),
    },
  })

  await prisma.subscription.create({
    data: {
      tenantId: t.id,
      planId: plan.id,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  })

  return t
}

describe('send pipeline (spec 10)', () => {
  before(() => stubPostal())

  beforeEach(async () => {
    postalCalls = []
    tenant = await seedTenant()
    await getRedis().del(`usage:day:${tenant.id}:${new Date().toISOString().slice(0, 10)}`)
  })

  after(async () => {
    globalThis.fetch = realFetch
    await prisma.message.deleteMany({ where: { tenant: { slug: { startsWith: 'test-' } } } })
    await prisma.tenant.deleteMany({ where: { slug: { startsWith: 'test-' } } })
    await prisma.$disconnect()
    disconnectRedis()
  })

  test('a valid message reaches Postal and is indexed', async () => {
    const result = await sendMessage(tenant, {
      from: 'Billing <billing@shop.example>',
      to: ['user@example.org'],
      subject: 'Your receipt',
      html: '<p>Thanks</p>',
      tag: 'receipt',
    })

    assert.equal(result.status, 'queued')
    assert.equal(postalCalls.length, 1)
    assert.match(postalCalls[0]!.url, /\/api\/v1\/send\/message$/)

    const indexed = await prisma.message.findFirst({ where: { tenantId: tenant.id } })
    assert.ok(indexed, 'message should be indexed for admin search')
    assert.equal(indexed.to, 'user@example.org')
    assert.equal(indexed.status, 'QUEUED')
    assert.equal(indexed.postalMessageId, '1000')
  })

  test('an unverified from-domain is rejected before Postal is called', async () => {
    await assert.rejects(
      sendMessage(tenant, {
        from: 'hello@not-mine.example',
        to: ['user@example.org'],
        subject: 'Hi',
        text: 'Hi',
      }),
      (err: unknown) => err instanceof ApiError && err.code === 'domain_not_added',
    )
    assert.equal(postalCalls.length, 0, 'Postal must not be touched for a rejected domain')
  })

  test('a suppressed recipient is dropped, and an all-suppressed send is rejected', async () => {
    await suppress({ tenantId: tenant.id, email: 'bounced@example.org', reason: 'HARD_BOUNCE' })

    await assert.rejects(
      sendMessage(tenant, {
        from: 'billing@shop.example',
        to: ['bounced@example.org'],
        subject: 'Hi',
        text: 'Hi',
      }),
      (err: unknown) => err instanceof ApiError && err.code === 'all_recipients_suppressed',
    )
    assert.equal(postalCalls.length, 0)

    // Mixed: the suppressed address is dropped, the rest still sends.
    const result = await sendMessage(tenant, {
      from: 'billing@shop.example',
      to: ['bounced@example.org', 'ok@example.org'],
      subject: 'Hi',
      text: 'Hi',
    })
    assert.deepEqual(result.suppressed, ['bounced@example.org'])
    assert.deepEqual(postalCalls[0]!.body, {
      ...(postalCalls[0]!.body as object),
      to: ['ok@example.org'],
    })
  })

  test('the daily cap is enforced and counts recipients, not requests', async () => {
    const capped = await seedTenant({ dailyCap: 3 })
    await getRedis().del(`usage:day:${capped.id}:${new Date().toISOString().slice(0, 10)}`)

    await sendMessage(capped, {
      from: 'billing@shop.example',
      to: ['a@example.org', 'b@example.org'],
      subject: 'Hi',
      text: 'Hi',
    })

    // 2 of 3 used; a 2-recipient message would exceed the cap.
    await assert.rejects(
      sendMessage(capped, {
        from: 'billing@shop.example',
        to: ['c@example.org', 'd@example.org'],
        subject: 'Hi',
        text: 'Hi',
      }),
      (err: unknown) => err instanceof ApiError && err.code === 'daily_cap_reached',
    )

    // The rejected reservation was released, so one more still fits.
    const ok = await sendMessage(capped, {
      from: 'billing@shop.example',
      to: ['c@example.org'],
      subject: 'Hi',
      text: 'Hi',
    })
    assert.equal(ok.status, 'queued')
  })

  test('a paused tenant cannot send, and the reason is surfaced', async () => {
    const paused = await prisma.tenant.update({
      where: { id: tenant.id },
      data: { status: 'PAUSED', statusReason: 'Bounce rate spike' },
    })

    await assert.rejects(
      sendMessage(paused, {
        from: 'billing@shop.example',
        to: ['user@example.org'],
        subject: 'Hi',
        text: 'Hi',
      }),
      (err: unknown) =>
        err instanceof ApiError && err.code === 'account_paused' && err.message === 'Bounce rate spike',
    )
    assert.equal(postalCalls.length, 0)
  })

  test('a tenant pending domain verification is blocked with a 403', async () => {
    const pending = await seedTenant({ status: 'PAUSED_PENDING_DOMAIN' })
    await assert.rejects(
      sendMessage(pending, {
        from: 'billing@shop.example',
        to: ['user@example.org'],
        subject: 'Hi',
        text: 'Hi',
      }),
      (err: unknown) => err instanceof ApiError && err.statusCode === 403,
    )
  })

  test('quota is released when Postal rejects the message', async () => {
    const key = `usage:day:${tenant.id}:${new Date().toISOString().slice(0, 10)}`
    stubPostal('error')

    await assert.rejects(
      sendMessage(tenant, {
        from: 'billing@shop.example',
        to: ['user@example.org'],
        subject: 'Hi',
        text: 'Hi',
      }),
      (err: unknown) => err instanceof ApiError && err.code === 'send_failed',
    )

    const used = Number((await getRedis().get(key)) ?? 0)
    assert.equal(used, 0, 'a Postal failure must not consume the customer allowance')
    stubPostal('success')
  })

  test('a message with no body is rejected', async () => {
    await assert.rejects(
      sendMessage(tenant, { from: 'billing@shop.example', to: ['a@example.org'], subject: 'Hi' }),
      (err: unknown) => err instanceof ApiError && err.code === 'empty_body',
    )
  })
})
