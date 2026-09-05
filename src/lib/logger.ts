import pino from 'pino'
import { config } from '../config.js'

export const logger = pino({
  level: config.isProd ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      '*.secret',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
  ...(config.isProd ? {} : { transport: { target: 'pino/file', options: { destination: 1 } } }),
})
