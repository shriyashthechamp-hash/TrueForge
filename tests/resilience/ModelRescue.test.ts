import { describe, it, expect } from 'vitest';
import { ModelRescue } from '../../src/resilience/ModelRescue.js';

describe('ModelRescue (System 06: Resilience & Recovery)', () => {
  const rescue = new ModelRescue(2);

  it('categorizes errors accurately into actionable taxonomy', () => {
    expect(rescue.categorizeError(new Error('connect ECONNREFUSED 127.0.0.1:8790'))).toBe('TRANSIENT_NETWORK');
    expect(rescue.categorizeError({ statusCode: 429, message: 'Too many requests' })).toBe('RATE_LIMITED');
    expect(rescue.categorizeError({ status: 503, message: 'Service Unavailable' })).toBe('PROVIDER_UNAVAILABLE');
    expect(rescue.categorizeError({ status: 401, message: 'Invalid API key' })).toBe('AUTHENTICATION_ERROR');
    expect(rescue.categorizeError({ status: 422, message: 'Unknown model groq/invalid' })).toBe('MODEL_NOT_FOUND');
    expect(rescue.categorizeError(new Error('maximum context length is 8192 tokens'))).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  it('sanitizes credentials and redacts API keys from error outputs', () => {
    const raw = 'Failed with token gsk_dummyMockKeyForTestRedactionOnly999 and Bearer eyJhbGciOiJIUzI1NiJ9.abc';
    const sanitized = rescue.sanitizeCredentials(raw);

    expect(sanitized).not.toContain('gsk_dummyMockKeyForTestRedactionOnly999');
    expect(sanitized).toContain('[REDACTED_GROQ_KEY]');
    expect(sanitized).toContain('Bearer [REDACTED_TOKEN]');
  });

  it('retries transient failures with exponential backoff and succeeds', async () => {
    let attempts = 0;
    const result = await rescue.executeWithRetry(async (attempt) => {
      attempts++;
      if (attempt === 0) {
        const err: any = new Error('fetch failed');
        err.code = 'ECONNRESET';
        throw err;
      }
      return 'SUCCESS_RESCUED';
    }, { initialDelayMs: 20 });

    expect(result).toBe('SUCCESS_RESCUED');
    expect(attempts).toBe(2);
  });
});
