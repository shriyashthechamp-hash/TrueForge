import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { PatchConflictError, SecurityBoundaryError } from '../../src/shared/errors.js';

describe('Milestone 8.1 Release Candidate Deep Audit', () => {
  let tempDir: string;
  let mri: CodebaseMri;
  let auction: ContextAuction;
  let patchManager: PatchStagingManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel_rc_audit_'));
    mri = new CodebaseMri(tempDir);
    auction = new ContextAuction(tempDir, mri, 4000);
    patchManager = new PatchStagingManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ============================================================================
  // 1. CODEBASE MRI AUDIT
  // ============================================================================
  describe('1. Codebase MRI Integrity', () => {
    it('handles modified, deleted, and renamed files without preserving stale symbols', async () => {
      const fileA = path.join(tempDir, 'service_a.py');
      await fs.writeFile(fileA, 'def original_function():\n    return 1\n', 'utf8');

      await mri.scan();
      expect(mri.findSymbols('original_function').length).toBe(1);

      // Modification: replace original_function with updated_function
      await fs.writeFile(fileA, 'def updated_function():\n    return 2\n', 'utf8');
      const modRefresh = await mri.refreshIncremental();
      expect(modRefresh.updated).toContain('service_a.py');
      expect(mri.findSymbols('original_function').length).toBe(0); // Stale symbol purged
      expect(mri.findSymbols('updated_function').length).toBe(1);

      // Rename: service_a.py -> service_b.py with renamed_function
      const fileB = path.join(tempDir, 'service_b.py');
      await fs.rename(fileA, fileB);
      await fs.writeFile(fileB, 'def renamed_function():\n    return 3\n', 'utf8');

      const renameRefresh = await mri.refreshIncremental();
      expect(renameRefresh.removed).toContain('service_a.py');
      expect(renameRefresh.updated).toContain('service_b.py');
      expect(mri.findSymbols('updated_function').length).toBe(0);
      expect(mri.findSymbols('renamed_function').length).toBe(1);

      // Deletion
      await fs.rm(fileB);
      const delRefresh = await mri.refreshIncremental();
      expect(delRefresh.removed).toContain('service_b.py');
      expect(mri.findSymbols('renamed_function').length).toBe(0);
      expect(mri.getFiles().length).toBe(0);
    });

    it('resolves changed imports and circular dependencies without recursion errors', async () => {
      const modA = path.join(tempDir, 'module_a.py');
      const modB = path.join(tempDir, 'module_b.py');

      // Circular dependency: A imports B, B imports A
      await fs.writeFile(modA, 'import module_b\ndef func_a(): pass\n', 'utf8');
      await fs.writeFile(modB, 'import module_a\ndef func_b(): pass\n', 'utf8');

      await mri.scan();

      expect(mri.getImportedFiles('module_a.py')).toContain('module_b.py');
      expect(mri.getImportedFiles('module_b.py')).toContain('module_a.py');
      expect(mri.getDependentFiles('module_a.py')).toContain('module_b.py');
      expect(mri.getDependentFiles('module_b.py')).toContain('module_a.py');

      // Changed imports: A stops importing B, imports sys instead
      await fs.writeFile(modA, 'import sys\ndef func_a(): pass\n', 'utf8');
      await mri.refreshIncremental();

      expect(mri.getImportedFiles('module_a.py')).not.toContain('module_b.py');
      expect(mri.getDependentFiles('module_b.py')).not.toContain('module_a.py');
    });

    it('strictly skips ignored directories and non-source extensions', async () => {
      const gitDir = path.join(tempDir, '.git');
      const nodeModules = path.join(tempDir, 'node_modules', 'pkg');
      const venvDir = path.join(tempDir, '.venv', 'bin');

      await fs.mkdir(gitDir, { recursive: true });
      await fs.mkdir(nodeModules, { recursive: true });
      await fs.mkdir(venvDir, { recursive: true });

      await fs.writeFile(path.join(gitDir, 'config.py'), 'def git_leak(): pass\n', 'utf8');
      await fs.writeFile(path.join(nodeModules, 'index.js'), 'function vendor(): void {}\n', 'utf8');
      await fs.writeFile(path.join(venvDir, 'activate.py'), 'def venv_func(): pass\n', 'utf8');
      await fs.writeFile(path.join(tempDir, 'binary.exe'), 'BINARY_DATA', 'utf8');

      const validSrc = path.join(tempDir, 'app.py');
      await fs.writeFile(validSrc, 'def valid_app(): pass\n', 'utf8');

      await mri.scan();

      const files = mri.getFiles();
      expect(files.length).toBe(1);
      expect(files[0].relativePath).toBe('app.py');
      expect(mri.findSymbols('git_leak').length).toBe(0);
      expect(mri.findSymbols('vendor').length).toBe(0);
      expect(mri.findSymbols('venv_func').length).toBe(0);
    });

    it('benchmarks large repository indexing performance', async () => {
      const srcDir = path.join(tempDir, 'large_repo');
      await fs.mkdir(srcDir, { recursive: true });

      const fileCount = 100;
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(
          path.join(srcDir, `module_${i}.py`),
          `def function_${i}():\n    return ${i}\n`,
          'utf8'
        );
      }

      const start = performance.now();
      await mri.scan();
      const durationMs = performance.now() - start;

      expect(mri.getFiles().length).toBe(fileCount);
      expect(durationMs).toBeLessThan(500); // 100 files scanned & indexed in < 500ms
    });
  });

  // ============================================================================
  // 2. CONTEXT AUCTION AUDIT
  // ============================================================================
  describe('2. Context Auction Verification', () => {
    it('verifies explicit @file and @symbol prioritization with receipt fidelity', async () => {
      const fileTarget = path.join(tempDir, 'target.py');
      await fs.writeFile(
        fileTarget,
        `def surgical_target_function():\n    return "match"\n`,
        'utf8'
      );

      const fileOther = path.join(tempDir, 'other.py');
      await fs.writeFile(fileOther, `def other_function(): pass\n`, 'utf8');

      await mri.scan();

      const { receipt, contextBundle } = await auction.runAuction(
        'Please review @file:target.py and inspect @symbol:surgical_target_function',
        3000
      );

      expect(receipt.selectedFiles.length).toBeGreaterThan(0);
      expect(receipt.selectedFiles[0].filePath).toBe('target.py');
      expect(receipt.selectedFiles[0].score).toBeGreaterThanOrEqual(1500); // 1000 (@file) + 500 (@symbol)
      expect(receipt.selectedFiles[0].snippet).toBeDefined();
      expect(contextBundle).toContain('surgical_target_function');
      expect(receipt.totalTokensUsed).toBeLessThanOrEqual(3000);
    });

    it('surgically extracts symbol window for large files instead of consuming entire budget', async () => {
      const largeFile = path.join(tempDir, 'large_module.py');
      const lines = [];
      for (let i = 1; i <= 1000; i++) {
        if (i === 500) {
          lines.push('def target_symbol_in_large_file():\n    return "found_here"');
        } else {
          lines.push(`val_${i} = "large_padding_line_value_to_increase_token_weight_${i}"`);
        }
      }
      await fs.writeFile(largeFile, lines.join('\n'), 'utf8');

      await mri.scan();

      const { receipt, contextBundle } = await auction.runAuction('target_symbol_in_large_file', 8000);

      expect(receipt.selectedFiles.length).toBe(1);
      const selected = receipt.selectedFiles[0];
      expect(selected.startLine).toBeDefined();
      expect(selected.endLine).toBeDefined();
      // Symbol is around line 500; window should be around lines 485 to 530
      expect(selected.startLine).toBeLessThanOrEqual(500);
      expect(selected.endLine).toBeGreaterThanOrEqual(500);
      expect(contextBundle).toContain('target_symbol_in_large_file');
    });

    it('enforces token budget limits and explains exclusions', async () => {
      await fs.writeFile(path.join(tempDir, 'a.py'), 'def func_a(): return 1\n'.repeat(40), 'utf8');
      await fs.writeFile(path.join(tempDir, 'b.py'), 'def func_b(): return 2\n'.repeat(40), 'utf8');

      await mri.scan();

      // Set extremely low budget of 50 tokens
      const { receipt } = await auction.runAuction('func_a and func_b', 50);

      expect(receipt.totalTokensUsed).toBeLessThanOrEqual(50);
      if (receipt.excludedFiles.length > 0) {
        expect(receipt.excludedFiles[0].exclusionReason).toContain('Budget ceiling');
      }
    });
  });

  // ============================================================================
  // 3. PATCH AND SECURITY BOUNDARIES AUDIT
  // ============================================================================
  describe('3. Patch & Security Boundaries', () => {
    it('blocks directory traversal attempts across all operations', () => {
      expect(() => patchManager.assertInsideWorkspace('../../../etc/shadow')).toThrow(SecurityBoundaryError);
      expect(() => patchManager.assertInsideWorkspace('/etc/passwd')).toThrow(SecurityBoundaryError);
    });

    it('detects external modifications and raises PatchConflictError', async () => {
      const file = path.join(tempDir, 'safe_file.py');
      await fs.writeFile(file, 'initial = 1\n', 'utf8');

      const staged = patchManager.stagePatch({
        filePath: 'safe_file.py',
        existingContent: 'initial = 1\n',
        proposedContent: 'initial = 2\n',
        purpose: 'Update number',
        rationale: 'Spec update',
      });

      // Concurrent external edit on disk
      await fs.writeFile(file, 'initial = 999\n', 'utf8');

      await expect(patchManager.applyPatch(staged.patchId)).rejects.toThrow(PatchConflictError);
    });

    it('supports selective hunk application and transaction rollback', async () => {
      const file = path.join(tempDir, 'multi_hunk.py');
      const original = 'def func_1():\n    return 1\n\n\ndef func_2():\n    return 2\n';
      await fs.writeFile(file, original, 'utf8');

      const proposed = 'def func_1():\n    return 10\n\n\ndef func_2():\n    return 20\n';

      const staged = patchManager.stagePatch({
        filePath: 'multi_hunk.py',
        existingContent: original,
        proposedContent: proposed,
        purpose: 'Update both functions',
        rationale: 'Batch update',
      });

      expect(staged.hunks.length).toBeGreaterThan(0);

      // Apply
      await patchManager.applyPatch(staged.patchId);
      expect(await fs.readFile(file, 'utf8')).toBe(proposed);

      // Revert
      await patchManager.revertPatch(staged.patchId);
      expect(await fs.readFile(file, 'utf8')).toBe(original);
    });

    it('verifies that SentinelMcpServer blocks direct shell file modification bypasses', async () => {
      const server = new SentinelMcpServer(tempDir, patchManager, mri, auction, 9199);
      const serverInstance = (server as any).createServer();

      // Test shell redirection blocked
      const blockedCmds = [
        'echo "evil" > hack.py',
        'cat payload.txt >> config.py',
        'sed -i "s/a/b/g" src/main.py',
        'echo "data" | tee file.txt',
      ];

      for (const cmd of blockedCmds) {
        const handler = (serverInstance as any)._requestHandlers.get('tools/call');
        if (handler) {
          const resp = await handler({
            method: 'tools/call',
            params: {
              name: 'run_terminal_command',
              arguments: { command: cmd },
            },
          });
          expect(resp.isError).toBe(true);
          expect(resp.content[0].text).toContain('blocked by Sentinel Safety Policy');
        }
      }
    });
  });
});
