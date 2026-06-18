export class RetryRunLaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryRunLaterError";
  }
}

export function isRetryRunLaterError(error: unknown): error is RetryRunLaterError {
  return error instanceof RetryRunLaterError;
}
