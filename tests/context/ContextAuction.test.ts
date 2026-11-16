import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';

describe('ContextAuction (System 02: Context Assembly & Selection)', () => {
  let tempDir: string;
  let mri: CodebaseMri;
  let auction: ContextAuction;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel_auction_test_'));
    mri = new CodebaseMri(tempDir);
    auction = new ContextAuction(tempDir, mri, 4000);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('parses explicit @file and @symbol mentions accurately', () => {
    const query = "Refactor @file:src/helpers.py and update @symbol:get_debug_flag to handle off values";
    const parsed = auction.parseExplicitMentions(query);

    expect(parsed.explicitFiles).toContain('src/helpers.py');
    expect(parsed.explicitSymbols).toContain('get_debug_flag');
    expect(parsed.cleanedQuery).toBe("Refactor  and update  to handle off values");
  });

  it('produces a valid ContextSelectionReceipt respecting token limits', async () => {
    const fileA = path.join(tempDir, 'helpers.py');
    await fs.writeFile(
      fileA,
      `def get_debug_flag():\n    return False\n`,
      'utf8'
    );

    const fileB = path.join(tempDir, 'cli.py');
    await fs.writeFile(
      fileB,
      `import click\ndef run_cli(): pass\n`,
      'utf8'
    );

    await mri.scan();

    const { receipt, contextBundle } = await auction.runAuction(
      "Fix get_debug_flag in helpers",
      2000
    );

    expect(receipt.query).toBe("Fix get_debug_flag in helpers");
    expect(receipt.retrievalStrategy).toBe("hybrid-symbol-bm25");
    expect(receipt.selectedFiles.length).toBeGreaterThan(0);
    expect(receipt.selectedFiles[0].filePath).toBe("helpers.py");
    expect(contextBundle).toContain("def get_debug_flag():");
    expect(receipt.totalTokensUsed).toBeLessThanOrEqual(2000);
  });
});

