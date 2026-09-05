/**
 * Every error surfaced to a customer carries a stable machine-readable code
 * so client libraries can branch on it, and a human message safe to display.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.message, detail: this.detail },
    }
  }
}

export const badRequest = (code: string, message: string, detail?: unknown) =>
  new ApiError(400, code, message, detail)

export const unauthorized = (message = 'Invalid or missing API key') =>
  new ApiError(401, 'unauthorized', message)

export const forbidden = (code: string, message: string) =>
  new ApiError(403, code, message)

export const notFound = (what = 'Resource') =>
  new ApiError(404, 'not_found', `${what} not found`)

export const conflict = (code: string, message: string) =>
  new ApiError(409, code, message)

/**
 * 402 is reserved for plan and quota conditions, so a customer's client can
 * distinguish "you have hit your cap" from "you are not allowed to do this".
 */
export const paymentRequired = (code: string, message: string, detail?: unknown) =>
  new ApiError(402, code, message, detail)

export const tooManyRequests = (message = 'Rate limit exceeded') =>
  new ApiError(429, 'rate_limited', message)
