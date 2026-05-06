export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
};

export async function withRetry<T>(operation: () => Promise<T>, options?: Partial<RetryOptions>): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 4;
  const baseDelayMs = options?.baseDelayMs ?? 250;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetriableError(error) || attempt === maxAttempts) {
        break;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function isRetriableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { name?: string; $retryable?: unknown };
  if (value.$retryable) {
    return true;
  }

  return value.name === "ThrottlingException" || value.name === "TooManyRequestsException";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
