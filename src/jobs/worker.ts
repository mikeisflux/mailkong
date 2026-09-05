import { Worker } from 'bullmq'
import { createRedis } from '../redis.js'
import { logger } from '../lib/logger.js'
import { prisma } from '../db.js'
import { QUEUE_NAMES, registerSchedules } from './queues.js'
import { deliverWebhook, type WebhookJob } from '../services/webhooks.js'
import { sweepDomains } from './dns.js'
import { pruneMessages, rollupUsage } from './usage.js'
import { sweepPolicy, warnApproachingCap, warnFailingWebhooks } from './policy.js'
import { pruneSessions } from '../auth/session.js'
import { checkPlatformHealth } from './health.js'

/**
 * Single worker process running every queue. Split it per queue only when
 * one starves the others -- at the volumes in docs/infrastructure.md that is
 * a long way off, and one process is one thing to supervise.
 */
const connection = () => createRedis({ forQueue: true })

const workers = [
  new Worker<WebhookJob>(
    QUEUE_NAMES.webhooks,
    async (job) => {
      const ok = await deliverWebhook(job.data)
      // Throwing is how BullMQ learns to retry; a 4xx from the receiver is
      // still a failure worth retrying, since the endpoint may be deploying.
      if (!ok) throw new Error(`webhook delivery failed for endpoint ${job.data.endpointId}`)
    },
    { connection: connection(), concurrency: 20 },
  ),

  new Worker(QUEUE_NAMES.dns, async () => sweepDomains(), {
    connection: connection(),
    concurrency: 1,
  }),

  new Worker(
    QUEUE_NAMES.usage,
    async () => {
      await rollupUsage()
      await warnApproachingCap()
      await warnFailingWebhooks()
    },
    { connection: connection(), concurrency: 1 },
  ),

  new Worker(QUEUE_NAMES.policy, async () => sweepPolicy(), {
    connection: connection(),
    concurrency: 1,
  }),

  new Worker(QUEUE_NAMES.health, async () => checkPlatformHealth(), {
    connection: connection(),
    concurrency: 1,
  }),

  new Worker(
    QUEUE_NAMES.maintenance,
    async () => {
      const [sessions, messages] = await Promise.all([pruneSessions(), pruneMessages()])
      logger.info({ sessions, messages: messages.deleted }, 'maintenance sweep complete')
    },
    { connection: connection(), concurrency: 1 },
  ),
]

for (const worker of workers) {
  worker.on('failed', (job, err) => {
    logger.error({ queue: worker.name, jobId: job?.id, attempt: job?.attemptsMade, err }, 'job failed')
  })
}

await registerSchedules()
logger.info({ queues: Object.values(QUEUE_NAMES) }, 'worker started')

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down')
  await Promise.allSettled(workers.map((w) => w.close()))
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
