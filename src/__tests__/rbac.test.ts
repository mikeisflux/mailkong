import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { adminCan, memberCan, requireMember } from '../auth/rbac.js'
import { ApiError } from '../lib/errors.js'

describe('customer role matrix (spec 8.3)', () => {
  test('only the owner can touch billing', () => {
    assert.equal(memberCan('OWNER', 'billing'), true)
    assert.equal(memberCan('ADMIN', 'billing'), false)
    assert.equal(memberCan('DEVELOPER', 'billing'), false)
    assert.equal(memberCan('READ_ONLY', 'billing'), false)
  })

  test('read-only cannot send or manage credentials', () => {
    assert.equal(memberCan('READ_ONLY', 'send'), false)
    assert.equal(memberCan('READ_ONLY', 'credentials'), false)
    assert.equal(memberCan('READ_ONLY', 'activity'), true)
    assert.equal(memberCan('READ_ONLY', 'domains:read'), true)
    assert.equal(memberCan('READ_ONLY', 'domains:write'), false)
  })

  test('developers cannot manage the team', () => {
    assert.equal(memberCan('DEVELOPER', 'team'), false)
    assert.equal(memberCan('ADMIN', 'team'), true)
  })

  test('every role can read activity', () => {
    for (const role of ['OWNER', 'ADMIN', 'DEVELOPER', 'READ_ONLY'] as const) {
      assert.equal(memberCan(role, 'activity'), true, `${role} should read activity`)
    }
  })

  test('requireMember throws a 403 ApiError, not a bare Error', () => {
    assert.throws(
      () => requireMember('READ_ONLY', 'send'),
      (err: unknown) => err instanceof ApiError && err.statusCode === 403,
    )
  })
})

describe('admin role matrix (spec 9.3)', () => {
  test('support can pause and impersonate but not move IP pools', () => {
    assert.equal(adminCan('SUPPORT', 'tenant:pause'), true)
    assert.equal(adminCan('SUPPORT', 'tenant:impersonate'), true)
    assert.equal(adminCan('SUPPORT', 'pool:write'), false)
  })

  test('billing can refund but cannot see messages or pause', () => {
    assert.equal(adminCan('BILLING', 'refunds'), true)
    assert.equal(adminCan('BILLING', 'plans:write'), true)
    assert.equal(adminCan('BILLING', 'messages:read'), false)
    assert.equal(adminCan('BILLING', 'tenant:pause'), false)
  })

  test('read-only can view messages and nothing else', () => {
    assert.equal(adminCan('READ_ONLY', 'messages:read'), true)
    assert.equal(adminCan('READ_ONLY', 'tenant:pause'), false)
    assert.equal(adminCan('READ_ONLY', 'tenant:impersonate'), false)
  })
})
