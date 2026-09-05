import { Queue } from 'bullmq'
import { createRedis } from '../redis.js'

export const QUEUE_NAMES = {
  webhooks: 'webhooks',
  dns: 'dns-checks',
  usage: 'usage',
  policy: 'policy',
  maintenance: 'maintenance',
  health: 'health',
} as const

const connection = () => createRedis({ forQueue: true })

export const dnsQueue = new Queue(QUEUE_NAMES.dns, { connection: connection() })
export const usageQueue = new Queue(QUEUE_NAMES.usage, { connection: connection() })
export const policyQueue = new Queue(QUEUE_NAMES.policy, { connection: connection() })
export const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, { connection: connection() })
export const healthQueue = new Queue(QUEUE_NAMES.health, { connection: connection() })

/**
 * Repeatable schedules. Registered on worker boot; BullMQ dedupes by key, so
 * restarting the worker does not multiply the schedule.
 */
export async function registerSchedules(): Promise<void> {
  // Spec 11: "Cron every 2 minutes: Postal domain query / DNS check".
  await dnsQueue.add('sweep', {}, { repeat: { every: 120_000 }, jobId: 'dns-sweep' })
  await usageQueue.add('rollup', {}, { repeat: { every: 300_000 }, jobId: 'usage-rollup' })
  await policyQueue.add('sweep', {}, { repeat: { every: 900_000 }, jobId: 'policy-sweep' })
  await maintenanceQueue.add('sweep', {}, { repeat: { every: 3_600_000 }, jobId: 'maintenance-sweep' })
  // Five minutes: fast enough that a stalled queue is noticed before customers
  // notice, slow enough that a flapping check does not become the outage.
  await healthQueue.add('check', {}, { repeat: { every: 300_000 }, jobId: 'health-check' })
}
