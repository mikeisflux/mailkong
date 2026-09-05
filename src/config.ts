import 'dotenv/config'
import { z } from 'zod'

const bool = z
  .string()
  .transform((v) => v === 'true' || v === '1')
  .pipe(z.boolean())

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  APP_URL: z.string().url(),
  ADMIN_URL: z.string().url(),
  API_URL: z.string().url(),
  PLATFORM_DOMAIN: z.string().min(1),

  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  POSTAL_API_URL: z.string().url(),
  POSTAL_API_KEY: z.string().default(''),
  POSTAL_SMTP_HOST: z.string(),
  POSTAL_SMTP_PORT: z.coerce.number().default(587),
  POSTAL_DEFAULT_POOL: z.string().default('shared-tx'),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  NEW_TENANT_DAILY_CAP: z.coerce.number().default(200),
  CLEAN_DAYS_BEFORE_RAISE: z.coerce.number().default(7),
  BOUNCE_RATE_PAUSE_THRESHOLD: z.coerce.number().default(0.08),
  COMPLAINT_RATE_PAUSE_THRESHOLD: z.coerce.number().default(0.001),
  SIGNUP_OPEN: bool.default('false'),

  ADMIN_IP_ALLOWLIST: z.string().default(''),

  // Where platform alerts go. Point this OFF this infrastructure -- an
  // outage that takes Postal down also takes the email path down.
  ALERT_WEBHOOK_URL: z.string().url().or(z.literal('')).default(''),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment configuration:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const config = {
  ...parsed.data,
  adminAllowlist: parsed.data.ADMIN_IP_ALLOWLIST.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
}

export type Config = typeof config
