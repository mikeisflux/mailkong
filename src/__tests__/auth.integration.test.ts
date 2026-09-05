import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../server.js'
import { prisma } from '../db.js'
import { disconnectRedis } from '../redis.js'
import { sha256, hashSecret } from '../lib/crypto.js'
import type { FastifyInstance } from 'fastify'

/**
 * The token flows, exercised through the real HTTP stack.
 *
 * These assert the security properties, not just the happy path: single use,
 * expiry, purpose separation, session invalidation on reset, and that the
 * email-taking endpoints cannot be used to enumerate accounts.
 */

let app: FastifyInstance
const EMAIL = 'authtest@example.org'

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload ?? {} })

async function makeUser(verified = false) {
  return prisma.user.create({
    data: {
      email: EMAIL,
      name: 'Auth Test',
      passwordHash: await hashSecret('correct-horse-battery'),
      emailVerified: verified,
    },
  })
}

async function issued(userId: string, purpose: string) {
  // The plaintext token only exists in the email, so tests mint their own and
  // write the digest the same way the application does.
  const token = `test-${purpose}-${Math.random().toString(36).slice(2)}`
  await prisma.loginToken.create({
    data: { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 600_000) },
  })
  return token
}

describe('auth flows', () => {
  before(async () => {
    app = await buildServer()
    await app.ready()
  })

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } })
  })

  after(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } })
    await app.close()
    await prisma.$disconnect()
    disconnectRedis()
  })

  // ------------------------------------------------------------ enumeration

  test('forgot-password answers identically for known and unknown addresses', async () => {
    await makeUser()
    const known = await post('/_app/auth/forgot-password', { email: EMAIL })
    const unknown = await post('/_app/auth/forgot-password', { email: 'nobody@example.org' })

    assert.equal(known.statusCode, unknown.statusCode)
    assert.deepEqual(known.json(), unknown.json())
  })

  test('magic-link answers identically for known and unknown addresses', async () => {
    await makeUser()
    const known = await post('/_app/auth/magic-link', { email: EMAIL })
    const unknown = await post('/_app/auth/magic-link', { email: 'nobody@example.org' })

    assert.equal(known.statusCode, unknown.statusCode)
    assert.deepEqual(known.json(), unknown.json())
  })

  // ----------------------------------------------------------- single use

  test('a magic link works once and then never again', async () => {
    const user = await makeUser()
    const token = await issued(user.id, 'magic_link')

    const first = await post(`/_app/auth/magic-link/${token}`)
    assert.equal(first.statusCode, 200)
    assert.ok(first.headers['set-cookie'], 'should establish a session')

    const second = await post(`/_app/auth/magic-link/${token}`)
    assert.equal(second.statusCode, 400)
    assert.equal(second.json().error.code, 'invalid_token')
  })

  test('following a magic link proves the address and marks it verified', async () => {
    const user = await makeUser(false)
    const token = await issued(user.id, 'magic_link')
    await post(`/_app/auth/magic-link/${token}`)

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(after.emailVerified, true)
  })

  test('an expired token is refused', async () => {
    const user = await makeUser()
    const token = 'expired-token-value'
    await prisma.loginToken.create({
      data: {
        userId: user.id,
        purpose: 'magic_link',
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() - 1000),
      },
    })

    const res = await post(`/_app/auth/magic-link/${token}`)
    assert.equal(res.statusCode, 400)
  })

  // ------------------------------------------------------ purpose separation

  test('a reset token cannot be redeemed as a magic link', async () => {
    const user = await makeUser()
    const token = await issued(user.id, 'password_reset')

    const res = await post(`/_app/auth/magic-link/${token}`)
    assert.equal(res.statusCode, 400, 'purposes must not be interchangeable')

    // And it still works for what it was issued for.
    const proper = await post(`/_app/auth/reset-password/${token}`, { password: 'a-new-long-password' })
    assert.equal(proper.statusCode, 200)
  })

  test('a verification token cannot be redeemed as a reset', async () => {
    const user = await makeUser()
    const token = await issued(user.id, 'verify_email')

    const res = await post(`/_app/auth/reset-password/${token}`, { password: 'a-new-long-password' })
    assert.equal(res.statusCode, 400)
  })

  // ------------------------------------------------------------- reset

  test('resetting the password destroys every existing session', async () => {
    const user = await makeUser()
    await prisma.session.create({
      data: { id: sha256('someone-elses-session'), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) },
    })

    const token = await issued(user.id, 'password_reset')
    const res = await post(`/_app/auth/reset-password/${token}`, { password: 'a-new-long-password' })
    assert.equal(res.statusCode, 200)

    const stale = await prisma.session.findUnique({ where: { id: sha256('someone-elses-session') } })
    assert.equal(stale, null, 'a reset is often a response to compromise')
  })

  test('the new password actually works and the old one does not', async () => {
    const user = await makeUser()
    const token = await issued(user.id, 'password_reset')
    await post(`/_app/auth/reset-password/${token}`, { password: 'a-new-long-password' })

    const withNew = await post('/_app/auth/login', { email: EMAIL, password: 'a-new-long-password' })
    assert.equal(withNew.statusCode, 200)

    const withOld = await post('/_app/auth/login', { email: EMAIL, password: 'correct-horse-battery' })
    assert.equal(withOld.statusCode, 401)
  })

  test('a short password is refused', async () => {
    const user = await makeUser()
    const token = await issued(user.id, 'password_reset')
    const res = await post(`/_app/auth/reset-password/${token}`, { password: 'short' })
    assert.equal(res.statusCode, 422)
  })

  test('requesting a second reset link retires the first', async () => {
    const user = await makeUser()
    const first = await issued(user.id, 'password_reset')
    await post('/_app/auth/forgot-password', { email: EMAIL })

    const res = await post(`/_app/auth/reset-password/${first}`, { password: 'a-new-long-password' })
    assert.equal(res.statusCode, 400, 'the superseded link must stop working')
  })

  // ------------------------------------------------------------- signup gate

  test('signup is refused while signup_open is off', async () => {
    await prisma.featureFlag.upsert({
      where: { key: 'signup_open' },
      create: { key: 'signup_open', enabled: false },
      update: { enabled: false },
    })

    const res = await post('/_app/auth/signup', {
      email: 'stranger@example.org',
      password: 'a-long-enough-password',
      name: 'Stranger',
      organization: 'Strangers Inc',
    })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error.code, 'signup_closed')
  })

  // ------------------------------------------------------------- login

  test('login rejects a wrong password without revealing whether the account exists', async () => {
    await makeUser()
    const wrongPassword = await post('/_app/auth/login', { email: EMAIL, password: 'nope' })
    const noAccount = await post('/_app/auth/login', { email: 'ghost@example.org', password: 'nope' })

    assert.equal(wrongPassword.statusCode, 401)
    assert.equal(noAccount.statusCode, 401)
    assert.equal(wrongPassword.json().error.message, noAccount.json().error.message)
  })
})
