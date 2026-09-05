import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { extractDomain } from '../services/domains.js'

describe('From address parsing', () => {
  test('handles a bare address', () => {
    assert.equal(extractDomain('billing@shop.com'), 'shop.com')
  })

  test('handles a display name', () => {
    assert.equal(extractDomain('Billing <billing@shop.com>'), 'shop.com')
  })

  test('handles a display name containing an @', () => {
    assert.equal(extractDomain('Support @ Shop <help@shop.com>'), 'shop.com')
  })

  test('lowercases the domain so verification lookups match', () => {
    assert.equal(extractDomain('Billing <Billing@Shop.COM>'), 'shop.com')
  })

  test('returns null when there is no address', () => {
    assert.equal(extractDomain('not an address'), null)
  })

  test('takes the last @ so subaddressing does not confuse it', () => {
    assert.equal(extractDomain('user+tag@sub.shop.com'), 'sub.shop.com')
  })
})
