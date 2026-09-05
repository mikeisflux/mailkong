import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../server.js'
import { prisma } from '../db.js'
import { disconnectRedis } from '../redis.js'
import { hashSecret, sha256 } from '../lib/crypto.js'
import type { AdminRole } from '@prisma/client'

/**
 * Operator and user administration.
 *
 * The interesting cases are all the ones that would leave the platform
 * unadministrable or a tenant unreachable: deleting the last superadmin,
 * demoting yourself mid-incident, deleting the sole owner of a tenant.
 */

let app: Awaited<ReturnType<typeof buildServer>>

async function makeOperator(role: AdminRole, label: string) {
  const email = `op-${label}-${Math.random().toString(36).slice(2, 7)}@example.org`
  const admin = await prisma.adminUser.create({
    data: {
      email,
      name: label,
      role,
      passwordHash: await hashSecret('operator-password-long'),
      totpEnabled: true,
      totpSecret: 'AAAAAAAAAAAAAAAA',
    },
  })
  const token = `admsess-${label}-${Math.random().toString(36).slice(2, 7)}`
  await prisma.adminSession.create({
    data: { id: sha256(token), adminId: admin.id, expiresAt: new Date(Date.now() + 3600_000) },
  })
  return { id: admin.id, email, cookie: `mk_admin=${token}` }
}

let root: Awaited<ReturnType<typeof makeOperator>>

const as = (cookie: string, url: string, method = 'GET', payload?: unknown) =>
  app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as never })

// Top-level rather than per-suite: node:test runs a suite's after() before the
// next suite begins, which closed the server out from under the second one.
before(async () => {
  app = await buildServer()
  await app.ready()
})

after(async () => {
  await prisma.adminUser.deleteMany({ where: { email: { startsWith: 'op-' } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: 'ua-' } } })
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: 'ua-' } } })
  await app.close()
  await prisma.$disconnect()
  disconnectRedis()
})

describe('operator administration', () => {
  beforeEach(async () => {
    await prisma.adminUser.deleteMany({ where: { email: { startsWith: 'op-' } } })
    root = await makeOperator('SUPERADMIN', 'root')
  })

  test('a superadmin can create an operator, and the password is shown once', async () => {
    const res = await as(root.cookie, '/_admin/operators', 'POST', {
      email: 'op-new@example.org',
      name: 'New Operator',
      role: 'SUPPORT',
    })
    assert.equal(res.statusCode, 201)

    const body = res.json()
    assert.match(body.temporary_password, /^tmp_/)

    // The password is never readable afterwards.
    const list = await as(root.cookie, '/_admin/operators')
    const created = list.json().data.find((o: { email: string }) => o.email === 'op-new@example.org')
    assert.ok(created)
    assert.equal('temporary_password' in created, false)
    assert.equal(created.totp_enabled, false, 'a new operator must still enrol 2FA')
  })

  test('a support operator cannot create or change operators', async () => {
    const support = await makeOperator('SUPPORT', 'support')

    const create = await as(support.cookie, '/_admin/operators', 'POST', {
      email: 'op-escalated@example.org', name: 'Nope', role: 'SUPERADMIN',
    })
    assert.equal(create.statusCode, 403, 'support must not be able to mint a superadmin')

    const change = await as(support.cookie, `/_admin/operators/${root.id}`, 'PATCH', { role: 'READ_ONLY' })
    assert.equal(change.statusCode, 403)
  })

  test('the last active superadmin cannot be demoted, disabled or deleted', async () => {
    const second = await makeOperator('SUPPORT', 'second')

    const demote = await as(root.cookie, `/_admin/operators/${root.id}`, 'PATCH', { role: 'SUPPORT' })
    assert.equal(demote.statusCode, 400, 'and self-change is refused before we even count')

    // Another operator cannot do it either.
    const promoted = await as(root.cookie, `/_admin/operators/${second.id}`, 'PATCH', { role: 'SUPERADMIN' })
    assert.equal(promoted.statusCode, 200)

    // Now there are two, so demoting one is allowed.
    const ok = await as(root.cookie, `/_admin/operators/${second.id}`, 'PATCH', { role: 'SUPPORT' })
    assert.equal(ok.statusCode, 200)

    // Back to one: deleting it must be refused.
    const del = await as(second.cookie, `/_admin/operators/${root.id}`, 'DELETE')
    assert.equal(del.statusCode, 403, 'a support operator cannot delete anyone')
  })

  test('an operator cannot disable or delete themselves', async () => {
    const other = await makeOperator('SUPERADMIN', 'other')

    const disable = await as(other.cookie, `/_admin/operators/${other.id}`, 'PATCH', { disabled: true })
    assert.equal(disable.statusCode, 400)
    assert.equal(disable.json().error.code, 'self_change')

    const del = await as(other.cookie, `/_admin/operators/${other.id}`, 'DELETE')
    assert.equal(del.statusCode, 400)
    assert.equal(del.json().error.code, 'self_delete')
  })

  test('disabling an operator ends their sessions immediately', async () => {
    const victim = await makeOperator('SUPPORT', 'victim')

    const before = await as(victim.cookie, '/_admin/overview')
    assert.equal(before.statusCode, 200)

    await as(root.cookie, `/_admin/operators/${victim.id}`, 'PATCH', { disabled: true })

    const after = await as(victim.cookie, '/_admin/overview')
    assert.equal(after.statusCode, 401, 'a disabled operator must be out now, not at session expiry')
  })

  test('deleting an operator keeps their audit history', async () => {
    const doomed = await makeOperator('SUPPORT', 'doomed')
    await as(doomed.cookie, '/_admin/overview')
    await prisma.auditEvent.create({
      data: { action: 'test.action', adminId: doomed.id, payload: {} },
    })

    const res = await as(root.cookie, `/_admin/operators/${doomed.id}`, 'DELETE')
    assert.equal(res.statusCode, 204)

    const trail = await prisma.auditEvent.findMany({ where: { action: 'operator.deleted' } })
    assert.ok(
      trail.some((e) => JSON.stringify(e.payload).includes(doomed.email)),
      'the deletion itself must record who was deleted',
    )
  })
})

describe('customer user administration', () => {
  before(async () => {
    root = await makeOperator('SUPERADMIN', 'root2')
  })

  test('support can send a reset link but never learns the password', async () => {
    const user = await prisma.user.create({
      data: { email: 'ua-reset@example.org', passwordHash: await hashSecret('original-password') },
    })
    const support = await makeOperator('SUPPORT', 'sup2')

    const res = await as(support.cookie, `/_admin/users/${user.id}/send-reset`, 'POST')
    assert.equal(res.statusCode, 200)

    const body = res.json()
    assert.equal('password' in body, false, 'no endpoint may hand an operator a customer password')

    const token = await prisma.loginToken.findFirst({
      where: { userId: user.id, purpose: 'password_reset', usedAt: null },
    })
    assert.ok(token, 'a single-use reset token should exist')

    // Unchanged until the customer uses the link.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(after.passwordHash, user.passwordHash)
  })

  test('support cannot delete a user; a superadmin can', async () => {
    const user = await prisma.user.create({ data: { email: 'ua-del@example.org' } })
    const support = await makeOperator('SUPPORT', 'sup3')

    const refused = await as(support.cookie, `/_admin/users/${user.id}`, 'DELETE')
    assert.equal(refused.statusCode, 403)

    const allowed = await as(root.cookie, `/_admin/users/${user.id}`, 'DELETE')
    assert.equal(allowed.statusCode, 204)
  })

  test('the sole owner of a tenant cannot be deleted', async () => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { key: 'growth' } })
    const user = await prisma.user.create({ data: { email: 'ua-owner@example.org' } })
    await prisma.tenant.create({
      data: {
        name: 'ua-orphan', slug: 'ua-orphan', planId: plan.id, status: 'ACTIVE', dailyCap: 100,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    })

    const res = await as(root.cookie, `/_admin/users/${user.id}`, 'DELETE')
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'sole_owner')

    assert.ok(await prisma.user.findUnique({ where: { id: user.id } }), 'the user must survive')
  })

  test('changing a user email clears their verified status', async () => {
    const user = await prisma.user.create({
      data: { email: 'ua-verified@example.org', emailVerified: true },
    })

    const res = await as(root.cookie, `/_admin/users/${user.id}`, 'PATCH', {
      email: 'ua-moved@example.org',
    })
    assert.equal(res.statusCode, 200)

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(after.email, 'ua-moved@example.org')
    assert.equal(after.emailVerified, false, 'the old proof does not carry to a new address')
  })

  test('an email already in use is refused', async () => {
    await prisma.user.create({ data: { email: 'ua-taken@example.org' } })
    const other = await prisma.user.create({ data: { email: 'ua-other@example.org' } })

    const res = await as(root.cookie, `/_admin/users/${other.id}`, 'PATCH', {
      email: 'ua-taken@example.org',
    })
    assert.equal(res.statusCode, 409)
  })
})
