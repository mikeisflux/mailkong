import { Redis } from 'ioredis'
import { config } from './config.js'

// BullMQ requires maxRetriesPerRequest: null on its connections.
export function createRedis(opts: { forQueue?: boolean } = {}) {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: opts.forQueue ? null : 3,
    enableReadyCheck: !opts.forQueue,
  })
}

export const redis = createRedis()
