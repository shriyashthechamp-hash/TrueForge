import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { PatchConflictError, SecurityBoundaryError } from '../../src/shared/errors.js';

describe('PatchStagingManager (System 03 & 05)', () => {
  let tempDir: string;
  let manager: PatchStagingManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel_diff_test_'));
    manager = new PatchStagingManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('stages a patch without modifying the target file', async () => {
    const filePath = path.join(tempDir, 'test.py');
    const originalContent = 'def add(a, b):\n    return a + b\n';
    await fs.writeFile(filePath, originalContent, 'utf8');

    const proposedContent = 'def add(a, b):\n    """Add two numbers."""\n    return a + b\n';

    const staged = manager.stagePatch({
      filePath: 'test.py',
      proposedContent,
      purpose: 'Add docstring',
      rationale: 'Documentation requirement',
      existingContent: originalContent,
    });

    expect(staged.patchId).toBeDefined();
    expect(staged.hunks.length).toBeGreaterThan(0);
    expect(staged.status).toBe('staged');

    // Verify target file was NOT touched
    const currentOnDisk = await fs.readFile(filePath, 'utf8');
    expect(currentOnDisk).toBe(originalContent);
  });

  it('applies an accepted patch safely to disk', async () => {
    const filePath = path.join(tempDir, 'calc.py');
    const originalContent = 'val = 1\n';
    await fs.writeFile(filePath, originalContent, 'utf8');

    const proposedContent = 'val = 2\n';

    const staged = manager.stagePatch({
      filePath: 'calc.py',
      proposedContent,
      purpose: 'Increment val',
      rationale: 'Bugfix',
      existingContent: originalContent,
    });

    const result = await manager.applyPatch(staged.patchId);
    expect(result.appliedContent).toBe(proposedContent);

    const onDisk = await fs.readFile(filePath, 'utf8');
    expect(onDisk).toBe(proposedContent);
    expect(manager.getPatch(staged.patchId)?.status).toBe('applied');
  });

  it('detects external modifications and raises PatchConflictError', async () => {
    const filePath = path.join(tempDir, 'conflict.py');
    const originalContent = 'a = 10\n';
    await fs.writeFile(filePath, originalContent, 'utf8');

    const staged = manager.stagePatch({
      filePath: 'conflict.py',
      proposedContent: 'a = 20\n',
      purpose: 'Update a',
      rationale: 'Config change',
      existingContent: originalContent,
    });

    // Simulate concurrent external modification
    await fs.writeFile(filePath, 'a = 999\n', 'utf8');

    await expect(manager.applyPatch(staged.patchId)).rejects.toThrow(PatchConflictError);
  });

  it('enforces security boundaries against path traversal', () => {
    expect(() => {
      manager.assertInsideWorkspace('../../../etc/passwd');
    }).toThrow(SecurityBoundaryError);
  });

  it('safely reverts applied patches', async () => {
    const filePath = path.join(tempDir, 'revert_test.py');
    const originalContent = 'initial = True\n';
    await fs.writeFile(filePath, originalContent, 'utf8');

    const staged = manager.stagePatch({
      filePath: 'revert_test.py',
      proposedContent: 'initial = False\n',
      purpose: 'Toggle',
      rationale: 'Test',
      existingContent: originalContent,
    });

    await manager.applyPatch(staged.patchId);
    expect(await fs.readFile(filePath, 'utf8')).toBe('initial = False\n');

    await manager.revertPatch(staged.patchId);
    expect(await fs.readFile(filePath, 'utf8')).toBe(originalContent);
    expect(manager.getPatch(staged.patchId)?.status).toBe('reverted');
  });
});

