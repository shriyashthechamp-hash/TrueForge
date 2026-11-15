import { describe, it, expect } from 'vitest';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';

describe('TrueForgeHarnessClient (Harness Connection)', () => {
  it('connects to running local TrueForge instance and retrieves health', async () => {
    const client = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');
    const health = await client.checkHealth();

    expect(health.status).toBe('ok');
    expect(health.version).toBeDefined();
  });
});
