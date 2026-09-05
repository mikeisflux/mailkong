/**
 * Postal's send API answers 200 with a JSON envelope whose `status` field
 * carries the real outcome, so failures must be unwrapped rather than
 * inferred from the HTTP status.
 */
export class PostalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'PostalError'
  }

  /** True when retrying the identical request could plausibly succeed. */
  get retryable(): boolean {
    if (this.httpStatus && this.httpStatus >= 500) return true
    return ['TimeoutError', 'ConnectionError', 'ServiceUnavailable'].includes(this.code)
  }
}

export class PostalUnreachableError extends PostalError {
  constructor(cause: unknown) {
    super('ConnectionError', `Postal is unreachable: ${String(cause)}`)
  }
}
