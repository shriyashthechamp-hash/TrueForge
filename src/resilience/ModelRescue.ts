export type ErrorCategory =
  | 'TRANSIENT_NETWORK'
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'AUTHENTICATION_ERROR'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'UNKNOWN';

export interface RetryOptions {
  operationName?: string;
  maxRetries?: number;
  initialDelayMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  isIdempotent?: boolean;
}

export class ModelRescue {
  constructor(private readonly defaultRetries = 3) {}

  public async executeWithRetry<T>(
    operation: (attempt: number) => Promise<T>,
    options?: RetryOptions
  ): Promise<T> {
    const opName = options?.operationName ?? 'Operation';
    const maxRetries = options?.maxRetries ?? this.defaultRetries;
    const initialDelay = options?.initialDelayMs ?? options?.baseDelayMs ?? 400;
    const maxDelay = options?.maxDelayMs ?? 4000;
    const factor = options?.backoffFactor ?? 2;
    const isIdempotent = options?.isIdempotent !== false;

    let attempt = 0;
    let delay = initialDelay;

    while (attempt <= maxRetries) {
      try {
        return await operation(attempt);
      } catch (err: any) {
        attempt++;
        const category = this.categorizeError(err);

        // Never replay non-idempotent operations unless error is purely connection refused before request sent
        if (!isIdempotent && category !== 'TRANSIENT_NETWORK') {
          throw this.enhanceError(err, opName, category);
        }

        if (attempt > maxRetries || !this.isTransientCategory(category)) {
          throw this.enhanceError(err, opName, category);
        }

        // Bounded exponential backoff with full jitter
        const jitter = Math.random() * delay * 0.5;
        await new Promise((res) => setTimeout(res, delay + jitter));
        delay = Math.min(delay * factor, maxDelay);
      }
    }

    throw new Error(`[FORGE//SENTINEL] ${opName} failed after ${maxRetries} retry attempts.`);
  }

  public categorizeError(err: any): ErrorCategory {
    const msg = String(err?.message ?? '').toLowerCase();
    const code = String(err?.code ?? '');
    const status = err?.status ?? err?.statusCode;

    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
      return 'RATE_LIMITED';
    }
    if (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('fetch failed')
    ) {
      return 'TRANSIENT_NETWORK';
    }
    if (status === 502 || status === 503 || status === 504 || msg.includes('bad gateway') || msg.includes('service unavailable')) {
      return 'PROVIDER_UNAVAILABLE';
    }
    if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('invalid api key')) {
      return 'AUTHENTICATION_ERROR';
    }
    if (status === 404 || status === 422 || msg.includes('model not found') || msg.includes('unknown model') || msg.includes('does not exist')) {
      return 'MODEL_NOT_FOUND';
    }
    if (msg.includes('context length') || msg.includes('maximum context') || msg.includes('too many tokens')) {
      return 'CONTEXT_WINDOW_EXCEEDED';
    }

    return 'UNKNOWN';
  }

  public isTransientCategory(category: ErrorCategory): boolean {
    return category === 'TRANSIENT_NETWORK' || category === 'PROVIDER_UNAVAILABLE' || category === 'RATE_LIMITED';
  }

  public isTransientError(err: any): boolean {
    return this.isTransientCategory(this.categorizeError(err));
  }

  public sanitizeCredentials(rawText: string): string {
    // Redact any Groq/OpenAI/Anthropic/generic tokens e.g. gsk_..., sk-..., etc.
    return rawText
      .replace(/gsk_[A-Za-z0-9_-]{10,}/gi, '[REDACTED_GROQ_KEY]')
      .replace(/sk-[A-Za-z0-9_-]{20,}/gi, '[REDACTED_API_KEY]')
      .replace(/bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi, 'Bearer [REDACTED_TOKEN]');
  }

  public enhanceError(err: any, operationName = 'Operation', category?: ErrorCategory): Error {
    const rawMsg = String(err?.message ?? err ?? '');
    const cleanMsg = this.sanitizeCredentials(rawMsg);
    const cat = category ?? this.categorizeError(err);

    switch (cat) {
      case 'TRANSIENT_NETWORK':
        return new Error(
          `[TrueForge Connection Failure] Cannot reach local TrueForge daemon on port 8790. Verify daemon is running with: NETWORK_POLICY_ENABLED=false node trueforge/packages/trueforge/dist/cli.js --port 8790. (${cleanMsg})`
        );
      case 'RATE_LIMITED':
        return new Error(
          `[Provider Rate Limit] Upstream model provider temporarily throttled requests. ModelRescue paused execution with exponential backoff. (${cleanMsg})`
        );
      case 'MODEL_NOT_FOUND':
        return new Error(
          `[Model Configuration Error] Configured model is unavailable or inactive in TrueForge. Please verify Settings -> Model Providers inside TrueForge. (${cleanMsg})`
        );
      case 'PROVIDER_UNAVAILABLE':
        return new Error(
          `[Provider Gateway Error] Upstream inference provider returned 502/503. Check provider status. (${cleanMsg})`
        );
      case 'AUTHENTICATION_ERROR':
        return new Error(
          `[Authentication Failure] Provider credentials invalid or expired. Check TrueForge provider settings. (${cleanMsg})`
        );
      case 'CONTEXT_WINDOW_EXCEEDED':
        return new Error(
          `[Context Limit Exceeded] Context tokens exceeded model limits. Context Auction budget constraint should be reduced. (${cleanMsg})`
        );
      default:
        return new Error(`[FORGE//SENTINEL Error] ${operationName} failed: ${cleanMsg}`);
    }
  }
}
