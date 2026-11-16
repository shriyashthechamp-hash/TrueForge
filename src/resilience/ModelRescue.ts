export type ErrorCategory =
  | 'TRANSIENT_NETWORK'
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
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
  abortSignal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; category: ErrorCategory; message: string }) => void;
}

export class ModelRescue {
  constructor(private readonly defaultRetries = 3) {}

  /**
   * Parses upstream Retry-After headers or Gemini RetryInfo / quota retry guidance
   * (e.g., "Please retry in 24.5s", "retryDelay": "18s", or Retry-After header seconds).
   */
  public extractRetryDelayMs(err: any): number | undefined {
    const headers = err?.headers ?? err?.response?.headers;
    if (headers) {
      const retryAfter =
        typeof headers.get === 'function'
          ? headers.get('retry-after')
          : (headers['retry-after'] ?? headers['Retry-After']);
      if (retryAfter) {
        const secs = Number(retryAfter);
        if (!Number.isNaN(secs) && secs > 0) {
          return Math.round(secs * 1000);
        }
      }
    }

    const msg = String(err?.message ?? err ?? '');
    const retryInMatch =
      msg.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes)/i) ??
      msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)(ms|s)"/i) ??
      msg.match(/retry_delay\s*\{\s*seconds:\s*(\d+)/i);

    if (retryInMatch) {
      const val = parseFloat(retryInMatch[1]);
      const unit = (retryInMatch[2] || 's').toLowerCase();
      if (unit === 'ms') return Math.round(val);
      if (unit.startsWith('m')) return Math.round(val * 60 * 1000);
      return Math.round(val * 1000);
    }

    return undefined;
  }

  public isQuotaExhausted(err: any): boolean {
    const msg = String(err?.message ?? err ?? '').toLowerCase();
    return (
      msg.includes('resource_exhausted') ||
      msg.includes('quota exceeded') ||
      msg.includes('free_tier') ||
      msg.includes('exceeded your current quota') ||
      msg.includes('generate_content_free_tier_requests')
    );
  }

  public isTransientOverload(err: any): boolean {
    const msg = String(err?.message ?? err ?? '').toLowerCase();
    const status = err?.status ?? err?.statusCode;
    return (
      status === 503 ||
      status === 504 ||
      msg.includes('503') ||
      msg.includes('high demand') ||
      msg.includes('spikes in demand') ||
      msg.includes('service unavailable') ||
      msg.includes('headers timeout') ||
      msg.includes('econnreset')
    );
  }

  /**
   * Cancellable sleep helper so retry backoff waits can be aborted immediately on user cancellation.
   */
  public sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      const abortErr = new Error('Operation cancelled during retry wait');
      abortErr.name = 'AbortError';
      return Promise.reject(abortErr);
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        const abortErr = new Error('Operation cancelled during retry wait');
        abortErr.name = 'AbortError';
        reject(abortErr);
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  public async executeWithRetry<T>(
    operation: (attempt: number) => Promise<T>,
    options?: RetryOptions
  ): Promise<T> {
    const opName = options?.operationName ?? 'Operation';
    const maxRetries = options?.maxRetries ?? this.defaultRetries;
    const initialDelay = options?.initialDelayMs ?? options?.baseDelayMs ?? 400;
    const maxDelay = options?.maxDelayMs ?? 15000;
    const factor = options?.backoffFactor ?? 2;
    const isIdempotent = options?.isIdempotent !== false;
    const signal = options?.abortSignal;

    let attempt = 0;
    let delay = initialDelay;

    while (attempt <= maxRetries) {
      if (signal?.aborted) {
        const abortErr = new Error('Operation cancelled');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      try {
        return await operation(attempt);
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          throw err;
        }

        attempt++;
        const category = this.categorizeError(err);

        // Never replay non-idempotent operations unless error is purely connection refused before request sent
        if (!isIdempotent && category !== 'TRANSIENT_NETWORK') {
          throw this.enhanceError(err, opName, category);
        }

        if (attempt > maxRetries || !this.isTransientCategory(category)) {
          throw this.enhanceError(err, opName, category);
        }

        // Respect provider retry guidance where available, bounded by maxDelay
        const providerGuidedDelay = this.extractRetryDelayMs(err);
        const jitter = Math.random() * delay * 0.4;
        const effectiveWaitMs = providerGuidedDelay
          ? Math.min(providerGuidedDelay + Math.round(Math.random() * 250), maxDelay)
          : Math.min(Math.round(delay + jitter), maxDelay);

        options?.onRetry?.({
          attempt,
          delayMs: effectiveWaitMs,
          category,
          message: this.sanitizeCredentials(String(err?.message ?? err)),
        });

        await this.sleepWithAbort(effectiveWaitMs, signal);
        delay = Math.min(delay * factor, maxDelay);
      }
    }

    throw new Error(`[FORGE//SENTINEL] ${opName} failed after ${maxRetries} retry attempts.`);
  }

  public categorizeError(err: any): ErrorCategory {
    const msg = String(err?.message ?? '').toLowerCase();
    const code = String(err?.code ?? '');
    const status = err?.status ?? err?.statusCode;

    if (
      status === 429 ||
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('too many requests') ||
      msg.includes('resource_exhausted') ||
      msg.includes('quota exceeded') ||
      msg.includes('exceeded your current quota') ||
      msg.includes('generate_content_free_tier_requests')
    ) {
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
      msg.includes('headers timeout') ||
      msg.includes('fetch failed')
    ) {
      return 'TRANSIENT_NETWORK';
    }
    if (
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('internal error') ||
      msg.includes('bad gateway') ||
      msg.includes('service unavailable') ||
      msg.includes('high demand') ||
      msg.includes('spikes in demand') ||
      msg.includes('overloaded')
    ) {
      return 'PROVIDER_UNAVAILABLE';
    }
    if (
      status === 401 ||
      status === 403 ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('invalid api key') ||
      msg.includes('api_key_invalid') ||
      msg.includes('api key not valid')
    ) {
      return 'AUTHENTICATION_ERROR';
    }
    if (
      status === 404 ||
      status === 422 ||
      msg.includes('model not found') ||
      msg.includes('unknown model') ||
      msg.includes('does not exist') ||
      msg.includes('is not found for api version')
    ) {
      return 'MODEL_NOT_FOUND';
    }
    if (msg.includes('context length') || msg.includes('maximum context') || msg.includes('too many tokens') || msg.includes('token limit')) {
      return 'CONTEXT_WINDOW_EXCEEDED';
    }

    return 'UNKNOWN';
  }

  public isTransientCategory(category: ErrorCategory): boolean {
    return (
      category === 'TRANSIENT_NETWORK' ||
      category === 'PROVIDER_UNAVAILABLE' ||
      category === 'RATE_LIMITED'
    );
  }

  public isTransientError(err: any): boolean {
    return this.isTransientCategory(this.categorizeError(err));
  }

  public sanitizeCredentials(rawText: string): string {
    // Redact Gemini (AIza..., AQ....), Groq (gsk_...), OpenAI (sk-...), Bearer tokens, and query/env key parameters
    return rawText
      .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED_GEMINI_KEY]')
      .replace(/AQ\.[A-Za-z0-9_\-]{20,}/g, '[REDACTED_GEMINI_KEY]')
      .replace(/gsk_[A-Za-z0-9_-]{10,}/gi, '[REDACTED_GROQ_KEY]')
      .replace(/gsk-[A-Za-z0-9_-]{10,}/gi, '[REDACTED_GROQ_KEY]')
      .replace(/sk-[A-Za-z0-9_-]{20,}/gi, '[REDACTED_API_KEY]')
      .replace(/bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi, 'Bearer [REDACTED_TOKEN]')
      .replace(/(GEMINI_API_KEY|GROQ_API_KEY|OPENAI_API_KEY|api_key|key)=([A-Za-z0-9_\-]{12,})/gi, '$1=[REDACTED_SECRET]');
  }

  public enhanceError(err: any, operationName = 'Operation', category?: ErrorCategory): Error {
    const rawMsg = String(err?.message ?? err ?? '');
    const cleanMsg = this.sanitizeCredentials(rawMsg);
    const cat = category ?? this.categorizeError(err);
    const retryDelayMs = this.extractRetryDelayMs(err);
    const retryHint = retryDelayMs
      ? ` Upstream provider suggests retrying in ~${Math.ceil(retryDelayMs / 1000)}s.`
      : '';

    switch (cat) {
      case 'TRANSIENT_NETWORK':
        return new Error(
          `[TrueForge Connection Failure] Cannot reach local TrueForge daemon on port 8790. Verify daemon is running with: NETWORK_POLICY_ENABLED=false node trueforge/packages/trueforge/dist/cli.js --port 8790. (${cleanMsg})`
        );
      case 'RATE_LIMITED': {
        if (this.isQuotaExhausted(err)) {
          return new Error(
            `[Gemini Free-Tier Quota Exhausted] Google Gemini API rate/quota limit (HTTP 429) reached.${retryHint || ' Please wait 30–60 seconds for the per-minute RPM/TPM window to reset before retrying.'} (${cleanMsg})`
          );
        }
        return new Error(
          `[Provider Rate Limit] Upstream model provider temporarily throttled requests (HTTP 429). ModelRescue paused execution with exponential backoff.${retryHint} (${cleanMsg})`
        );
      }
      case 'MODEL_NOT_FOUND':
        return new Error(
          `[Model Configuration Error] Configured model is unavailable or inactive in TrueForge. Please verify Settings -> Model Providers (google-gemini/gemini-3-8-flash) inside TrueForge. (${cleanMsg})`
        );
      case 'PROVIDER_UNAVAILABLE':
        return new Error(
          `[Provider Gateway Error] Upstream inference provider returned HTTP 500/502/503 transient failure.${retryHint} Check provider status. (${cleanMsg})`
        );
      case 'AUTHENTICATION_ERROR':
        return new Error(
          `[Authentication Failure] Provider credentials (GEMINI_API_KEY) invalid or expired. Check TrueForge provider settings. (${cleanMsg})`
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
