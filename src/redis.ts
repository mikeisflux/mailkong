import { Redis } from 'ioredis'
import { config } from './config.js'

/** BullMQ requires maxRetriesPerRequest: null on the connections it owns. */
export function createRedis(opts: { forQueue?: boolean } = {}) {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: opts.forQueue ? null : 3,
    enableReadyCheck: !opts.forQueue,
    lazyConnect: true,
  })
}

let shared: Redis | null = null

/**
 * The process-wide connection, opened on first use rather than at import.
 *
 * Connecting eagerly at module load keeps the event loop alive, so anything
 * that transitively imports this module -- including unit tests that never
 * touch Redis -- hangs instead of exiting.
 */
export function getRedis(): Redis {
  shared ??= createRedis()
  return shared
}

export function disconnectRedis(): void {
  shared?.disconnect()
  shared = null
}
