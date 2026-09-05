import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  decrypt,
  encrypt,
  generateApiKey,
  hashSecret,
  safeEqual,
  signPayload,
  verifySecret,
} from '../lib/crypto.js'
import { buildSignatureHeaders } from '../services/webhooks.js'

describe('secret handling', () => {
  test('encrypt round-trips and is non-deterministic', () => {
    const secret = 'postal-server-api-key-12345'
    const a = encrypt(secret)
    const b = encrypt(secret)
    assert.notEqual(a, b, 'same plaintext must not produce the same ciphertext')
    assert.equal(decrypt(a), secret)
    assert.equal(decrypt(b), secret)
  })

  test('tampered ciphertext fails authentication rather than decrypting', () => {
    const payload = encrypt('sensitive')
    const [iv, tag, data] = payload.split('.')
    const flipped = Buffer.from(data!, 'base64')
    flipped[0] = flipped[0]! ^ 0xff
    assert.throws(() => decrypt([iv, tag, flipped.toString('base64')].join('.')))
  })

  test('argon2 verification accepts the right secret and rejects others', async () => {
    const hash = await hashSecret('correct horse battery staple')
    assert.equal(await verifySecret(hash, 'correct horse battery staple'), true)
    assert.equal(await verifySecret(hash, 'wrong'), false)
  })

  test('verifySecret returns false on a malformed hash instead of throwing', async () => {
    assert.equal(await verifySecret('not-a-hash', 'anything'), false)
  })

  test('api keys carry the live prefix and a stable prefix length', () => {
    const { key, prefix } = generateApiKey()
    assert.ok(key.startsWith('pk_live_'))
    assert.equal(prefix, key.slice(0, 16))
    assert.equal(prefix.length, 16)
  })

  test('safeEqual rejects different lengths without throwing', () => {
    assert.equal(safeEqual('abc', 'abcd'), false)
    assert.equal(safeEqual('abc', 'abc'), true)
  })
})

describe('webhook signatures (spec 10)', () => {
  test('signature covers the timestamp so payloads cannot be replayed forever', () => {
    const body = JSON.stringify({ event: 'message.delivered' })
    const headers = buildSignatureHeaders('whsec_test', body)
    const timestamp = headers['X-Mail-Timestamp']!

    const expected = signPayload('whsec_test', `${timestamp}.${body}`)
    assert.equal(headers['X-Mail-Signature'], expected)

    // The naive signature over the body alone must NOT validate.
    assert.notEqual(headers['X-Mail-Signature'], signPayload('whsec_test', body))
  })

  test('a different secret produces a different signature', () => {
    const body = '{"a":1}'
    const one = signPayload('secret-a', body)
    const two = signPayload('secret-b', body)
    assert.notEqual(one, two)
  })
})
