import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import argon2 from 'argon2'
import { config } from '../config.js'

const KEY = createHash('sha256').update(config.ENCRYPTION_KEY).digest()

/** Password and secret hashing. Argon2id with sensible interactive params. */
export const hashSecret = (plain: string) =>
  argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })

export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

/**
 * Reversible encryption for values we must hand back to Postal later, such
 * as SMTP credential passwords. Never used for anything a user proves
 * knowledge of; those are hashed.
 */
export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.')
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}

/** Opaque tokens for sessions, magic links and invites. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

/** Fast deterministic hash for token lookup columns. Not for passwords. */
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')

/**
 * Webhook signature. Customers verify with the endpoint secret shown once
 * at creation: HMAC-SHA256 over the raw body (spec 10).
 */
export const signPayload = (secret: string, rawBody: string) =>
  createHmac('sha256', secret).update(rawBody).digest('hex')

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * API keys are `pk_live_<32 url-safe chars>`. The prefix stored alongside the
 * hash is the first 12 characters, which is enough to identify a key in the
 * UI and to narrow the hash comparison to a handful of candidate rows.
 */
export function generateApiKey(): { key: string; prefix: string } {
  const key = `pk_live_${randomToken(24)}`
  return { key, prefix: key.slice(0, 16) }
}

export function generateSmtpPassword(): string {
  return randomToken(18)
}
