export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export class ModelRescue {
  constructor(private readonly defaultRetries = 3) {}

  public async executeWithRetry<T>(
    operation: (attempt: number) => Promise<T>,
    options?: RetryOptions
  ): Promise<T> {
    const maxRetries = options?.maxRetries ?? this.defaultRetries;
    const initialDelay = options?.initialDelayMs ?? 500;
    const maxDelay = options?.maxDelayMs ?? 4000;
    const factor = options?.backoffFactor ?? 2;

    let attempt = 0;
    let delay = initialDelay;

    while (attempt <= maxRetries) {
      try {
        return await operation(attempt);
      } catch (err: any) {
        attempt++;
        if (attempt > maxRetries || !this.isTransientError(err)) {
          throw this.enhanceError(err);
        }

        const jitter = Math.random() * 100;
        await new Promise((res) => setTimeout(res, delay + jitter));
        delay = Math.min(delay * factor, maxDelay);
      }
    }

    throw new Error('Operation failed after max retries.');
  }

  public isTransientError(err: any): boolean {
    const msg = String(err?.message ?? '').toLowerCase();
    const code = String(err?.code ?? '');
    return (
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('network') ||
      msg.includes('socket hang up') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      code === 'ECONNRESET' ||
      code === 'EPIPE'
    );
  }

  public enhanceError(err: any): Error {
    const msg = String(err?.message ?? '');
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return new Error(
        `[TrueForge Unavailable] Cannot reach local TrueForge server at port 8790. Please verify the harness daemon is running (node trueforge/packages/trueforge/dist/cli.js --port 8790). Original error: ${msg}`
      );
    }
    if (msg.includes('404') && msg.includes('model')) {
      return new Error(
        `[Model Not Configured] TrueForge reports no available model. Please configure an LLM provider inside TrueForge (Settings -> Model Providers).`
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

