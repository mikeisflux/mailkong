import { PrismaClient } from '@prisma/client'
import argon2 from 'argon2'

const prisma = new PrismaClient()

/**
 * Plans from spec 6. Numbers are a starting point; they are editable from
 * the admin console without a migration because limits are stored as JSON.
 *
 * -1 means unlimited.
 */
const PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    monthlyPrice: 1500,
    limits: { monthlySends: 50_000, domains: 3, webhooks: 2, routes: 5, retentionDays: 7, dedicatedIp: false },
  },
  {
    key: 'growth',
    name: 'Growth',
    monthlyPrice: 5000,
    limits: { monthlySends: 250_000, domains: 15, webhooks: 10, routes: 25, retentionDays: 30, dedicatedIp: false },
  },
  {
    key: 'pro',
    name: 'Pro',
    monthlyPrice: 15000,
    limits: { monthlySends: 1_000_000, domains: -1, webhooks: -1, routes: -1, retentionDays: 90, dedicatedIp: true },
  },
  {
    // Spec 14: "Your own sites: tenant internal, plan $0, same dashboard so
    // you eat your own product."
    key: 'internal',
    name: 'Internal',
    monthlyPrice: 0,
    public: false,
    limits: { monthlySends: -1, domains: -1, webhooks: -1, routes: -1, retentionDays: 90, dedicatedIp: true },
  },
]

const FLAGS = [
  { key: 'signup_open', enabled: false },
  { key: 'inbound_enabled', enabled: true },
  { key: 'tracking_enabled', enabled: true },
  { key: 'maintenance_banner', enabled: false },
]

async function main() {
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { key: plan.key },
      create: {
        key: plan.key,
        name: plan.name,
        monthlyPrice: plan.monthlyPrice,
        limits: plan.limits,
        public: plan.public ?? true,
      },
      update: { name: plan.name, monthlyPrice: plan.monthlyPrice, limits: plan.limits },
    })
  }

  for (const flag of FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      create: flag,
      update: {},
    })
  }

  // Shared transactional pool, spec 5. Addresses are added from the admin
  // console once OVH delivers them.
  await prisma.ipPool.upsert({
    where: { name: 'shared-tx' },
    create: { name: 'shared-tx', kind: 'SHARED_TX' },
    update: {},
  })

  const email = process.env.SEED_ADMIN_EMAIL
  const password = process.env.SEED_ADMIN_PASSWORD
  if (email && password) {
    await prisma.adminUser.upsert({
      where: { email: email.toLowerCase() },
      create: {
        email: email.toLowerCase(),
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        role: 'SUPERADMIN',
        name: 'Founder',
      },
      update: {},
    })
    console.log(`Seeded superadmin ${email}. Enrol TOTP before first login.`)
  } else {
    console.log('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create the first operator.')
  }

  console.log(`Seeded ${PLANS.length} plans, ${FLAGS.length} flags, 1 IP pool.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
