import { PrismaClient } from '@prisma/client'
import { config } from './config.js'

export const prisma = new PrismaClient({
  log: config.isProd ? ['warn', 'error'] : ['warn', 'error'],
})

export type { Prisma } from '@prisma/client'
