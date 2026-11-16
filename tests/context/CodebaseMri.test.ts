import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';

describe('CodebaseMri (System 01: Repository Intelligence)', () => {
  let tempDir: string;
  let mri: CodebaseMri;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel_mri_test_'));
    mri = new CodebaseMri(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('scans files, extracts functions, classes and imports', async () => {
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });

    const pyFile = path.join(srcDir, 'auth.py');
    const pyContent = `import hashlib
from os import getenv

class AuthManager:
    def __init__(self):
        pass

def authenticate_user(username, token):
    return True
`;
    await fs.writeFile(pyFile, pyContent, 'utf8');

    const testDir = path.join(tempDir, 'tests');
    await fs.mkdir(testDir, { recursive: true });
    const testFile = path.join(testDir, 'test_auth.py');
    await fs.writeFile(testFile, 'from src.auth import authenticate_user\ndef test_login(): pass\n', 'utf8');

    const index = await mri.scan();
    expect(index.size).toBe(2);

    const authMeta = mri.getFile('src/auth.py');
    expect(authMeta).toBeDefined();
    expect(authMeta?.language).toBe('python');
    expect(authMeta?.imports).toContain('hashlib');

    const symbols = authMeta?.symbols ?? [];
    expect(symbols.some((s) => s.name === 'AuthManager' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.name === 'authenticate_user' && s.kind === 'function')).toBe(true);

    const linkedTests = mri.getTestsForSource('src/auth.py');
    expect(linkedTests).toContain('tests/test_auth.py');
  });

  it('finds symbols by substring search', async () => {
    const file = path.join(tempDir, 'service.ts');
    await fs.writeFile(
      file,
      `export class PaymentGateway {}\nexport function processRefund() {}\n`,
      'utf8'
    );

    await mri.scan();
    const found = mri.findSymbols('refund');
    expect(found.length).toBe(1);
    expect(found[0].name).toBe('processRefund');
  });

  it('refreshes incrementally without rescanning unchanged files', async () => {
    const fileA = path.join(tempDir, 'module_a.py');
    await fs.writeFile(fileA, 'def func_a(): pass\n', 'utf8');
    await mri.scan();

    expect(mri.getFiles().length).toBe(1);
    expect(mri.findSymbols('func_a').length).toBe(1);

    // Add module_b.py
    const fileB = path.join(tempDir, 'module_b.py');
    await fs.writeFile(fileB, 'def func_b(): pass\n', 'utf8');

    const refreshResult = await mri.refreshIncremental();
    expect(refreshResult.updated).toContain('module_b.py');
    expect(mri.findSymbols('func_b').length).toBe(1);

    // Delete module_a.py
    await fs.rm(fileA);
    const deleteResult = await mri.refreshIncremental();
    expect(deleteResult.removed).toContain('module_a.py');
    expect(mri.findSymbols('func_a').length).toBe(0);
  });

  it('builds import graphs and reverse import dependencies', async () => {
    const helperFile = path.join(tempDir, 'helpers.py');
    await fs.writeFile(helperFile, 'def helper(): pass\n', 'utf8');

    const mainFile = path.join(tempDir, 'main.py');
    await fs.writeFile(mainFile, 'import helpers\ndef run(): pass\n', 'utf8');

    await mri.scan();

    const mainImports = mri.getImportedFiles('main.py');
    expect(mainImports).toContain('helpers.py');

    const helperDependents = mri.getDependentFiles('helpers.py');
    expect(helperDependents).toContain('main.py');
  });
});
