import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { ZodError } from 'zod'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { ApiError } from './lib/errors.js'
import { prisma } from './db.js'
import { disconnectRedis, getRedis } from './redis.js'
import { requireApiKey } from './api/context.js'
import { messageRoutes } from './api/v1/messages.js'
import { resourceRoutes } from './api/v1/resources.js'
import { postalEventRoutes } from './api/postalEvents.js'
import { appRoutes } from './app/routes.js'
import { adminRoutes } from './admin/routes.js'
import { stripeWebhookRoutes } from './billing/webhooks.js'

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    bodyLimit: 30 * 1024 * 1024, // attachments
    genReqId: () => crypto.randomUUID(),
  })

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cookie, { secret: config.SESSION_SECRET })
  await app.register(cors, {
    origin: [config.APP_URL, config.ADMIN_URL],
    credentials: true,
  })

  // Redis-backed so the limit holds across processes, not per-instance.
  await app.register(rateLimit, {
    global: false,
    redis: getRedis(),
    keyGenerator: (req) => req.apiTenant?.id ?? req.ip,
  })

  // -------------------------------------------------------- error handling

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode)
      return reply.send(error.toJSON())
    }
    if (error instanceof ZodError) {
      reply.code(422)
      return reply.send({
        error: {
          code: 'validation_failed',
          message: 'The request body failed validation',
          detail: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      reply.code(429)
      return reply.send({ error: { code: 'rate_limited', message: 'Too many requests' } })
    }

    req.log.error({ err: error }, 'unhandled error')
    reply.code(500)
    return reply.send({
      error: {
        code: 'internal_error',
        message: 'Something went wrong on our side',
        // The request id is the only thing a customer needs to quote to
        // support, and the only internal detail worth leaking.
        request_id: req.id,
      },
    })
  })

  // ------------------------------------------------------------ health

  app.get('/health', async () => {
    const [db, cache] = await Promise.allSettled([
      prisma.$queryRaw`SELECT 1`,
      getRedis().ping(),
    ])
    const ok = db.status === 'fulfilled' && cache.status === 'fulfilled'
    return {
      ok,
      db: db.status === 'fulfilled',
      redis: cache.status === 'fulfilled',
      version: process.env.GIT_SHA ?? 'dev',
    }
  })

  // ------------------------------------------------------------ public API

  await app.register(
    async (v1) => {
      v1.addHook('preHandler', requireApiKey)
      // Sending is the expensive path; reads are cheap. Separate buckets.
      v1.register(async (send) => {
        send.addHook(
          'onRequest',
          send.rateLimit({ max: 300, timeWindow: '1 minute' }),
        )
        await messageRoutes(send)
      })
      await resourceRoutes(v1)
    },
    { prefix: '/v1' },
  )

  // ------------------------------------------ internal and dashboard routes

  await app.register(postalEventRoutes, { prefix: '/_postal' })
  await app.register(stripeWebhookRoutes, { prefix: '/_stripe' })
  await app.register(appRoutes, { prefix: '/_app' })
  await app.register(adminRoutes, { prefix: '/_admin' })

  return app
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer()
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' })
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'mailkong control plane listening')
  } catch (err) {
    logger.fatal({ err }, 'failed to start')
    process.exit(1)
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void (async () => {
        logger.info({ signal }, 'shutting down')
        await app.close()
        await prisma.$disconnect()
        disconnectRedis()
        process.exit(0)
      })()
    })
  }
}
