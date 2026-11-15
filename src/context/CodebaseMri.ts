import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CodeSymbol, FileMetadata } from '../shared/types.js';

export class CodebaseMri {
  private fileIndex = new Map<string, FileMetadata>();
  private symbolIndex = new Map<string, CodeSymbol[]>();
  private testToSourceMap = new Map<string, string[]>();
  private sourceToTestMap = new Map<string, string[]>();
  private isScanning = false;

  private readonly IGNORED_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'out',
    '__pycache__',
    '.pytest_cache',
    '.venv',
    'venv',
    '.idea',
    '.vscode',
    'coverage',
    '.egg-info',
  ]);

  constructor(private readonly workspaceRoot: string) {}

  public async scan(): Promise<Map<string, FileMetadata>> {
    this.isScanning = true;
    try {
      this.fileIndex.clear();
      this.symbolIndex.clear();
      this.testToSourceMap.clear();
      this.sourceToTestMap.clear();

      await this.scanDirectory(this.workspaceRoot);
      this.correlateTestsAndSources();
      return this.fileIndex;
    } finally {
      this.isScanning = false;
    }
  }

  private async scanDirectory(dirPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (this.IGNORED_DIRS.has(entry) || entry.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dirPath, entry);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await this.scanDirectory(fullPath);
      } else if (stat.isFile()) {
        await this.indexFile(fullPath, stat.size, stat.mtimeMs);
      }
    }
  }

  public async indexFile(fullPath: string, sizeBytes?: number, mtimeMs?: number): Promise<FileMetadata | undefined> {
    const relativePath = path.relative(this.workspaceRoot, fullPath);
    const ext = path.extname(fullPath).toLowerCase();

    const SUPPORTED_EXTS = new Set([
      '.py',
      '.ts',
      '.js',
      '.tsx',
      '.jsx',
      '.json',
      '.md',
      '.rst',
      '.html',
      '.css',
      '.yaml',
      '.yml',
      '.toml',
    ]);

    if (!SUPPORTED_EXTS.has(ext)) {
      return undefined;
    }

    let content = '';
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      return undefined;
    }

    const language = this.detectLanguage(ext);
    const isTest = this.isTestPath(relativePath);
    const symbols = this.extractSymbols(content, relativePath, language);
    const imports = this.extractImports(content, language);

    const meta: FileMetadata = {
      relativePath,
      absolutePath: fullPath,
      sizeBytes: sizeBytes ?? content.length,
      lastModifiedMs: mtimeMs ?? Date.now(),
      language,
      isTestFile: isTest,
      imports,
      symbols,
    };

    this.fileIndex.set(relativePath, meta);
    for (const sym of symbols) {
      const existing = this.symbolIndex.get(sym.name) ?? [];
      existing.push(sym);
      this.symbolIndex.set(sym.name, existing);
    }

    return meta;
  }

  private detectLanguage(ext: string): string {
    switch (ext) {
      case '.py': return 'python';
      case '.ts': case '.tsx': return 'typescript';
      case '.js': case '.jsx': return 'javascript';
      case '.json': return 'json';
      case '.md': case '.rst': return 'markdown';
      case '.html': return 'html';
      case '.css': return 'css';
      default: return 'text';
    }
  }

  private isTestPath(relPath: string): boolean {
    const lower = relPath.toLowerCase();
    const basename = path.basename(lower);
    return (
      lower.includes('test') ||
      basename.startsWith('test_') ||
      basename.endsWith('_test.py') ||
      basename.endsWith('.test.ts') ||
      basename.endsWith('.test.js') ||
      basename.endsWith('.spec.ts') ||
      basename.endsWith('.spec.js')
    );
  }

  private extractSymbols(content: string, filePath: string, language: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    if (language === 'python') {
      const pyFuncRegex = /^\s*def\s+([a-zA-Z0-9_]+)\s*\(/;
      const pyClassRegex = /^\s*class\s+([a-zA-Z0-9_]+)\s*(\(|:)/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const funcMatch = line.match(pyFuncRegex);
        if (funcMatch) {
          symbols.push({
            name: funcMatch[1],
            kind: 'function',
            filePath,
            startLine: i + 1,
            endLine: i + 1,
          });
          continue;
        }
        const classMatch = line.match(pyClassRegex);
        if (classMatch) {
          symbols.push({
            name: classMatch[1],
            kind: 'class',
            filePath,
            startLine: i + 1,
            endLine: i + 1,
          });
        }
      }
    } else if (language === 'typescript' || language === 'javascript') {
      const jsFuncRegex = /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/;
      const jsClassRegex = /^\s*(?:export\s+)?class\s+([a-zA-Z0-9_]+)/;
      const jsConstFuncRegex = /^\s*(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const funcMatch = line.match(jsFuncRegex) || line.match(jsConstFuncRegex);
        if (funcMatch) {
          symbols.push({
            name: funcMatch[1],
            kind: 'function',
            filePath,
            startLine: i + 1,
            endLine: i + 1,
          });
          continue;
        }
        const classMatch = line.match(jsClassRegex);
        if (classMatch) {
          symbols.push({
            name: classMatch[1],
            kind: 'class',
            filePath,
            startLine: i + 1,
            endLine: i + 1,
          });
        }
      }
    }

    return symbols;
  }

  private extractImports(content: string, language: string): string[] {
    const imports: string[] = [];
    const lines = content.split('\n');

    if (language === 'python') {
      for (const line of lines) {
        const fromMatch = line.match(/^\s*from\s+([a-zA-Z0-9_.]+)\s+import/);
        if (fromMatch) imports.push(fromMatch[1]);
        const importMatch = line.match(/^\s*import\s+([a-zA-Z0-9_.]+)/);
        if (importMatch) imports.push(importMatch[1]);
      }
    } else if (language === 'typescript' || language === 'javascript') {
      for (const line of lines) {
        const match = line.match(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/);
        if (match) imports.push(match[1]);
      }
    }

    return Array.from(new Set(imports));
  }

  private correlateTestsAndSources(): void {
    const testFiles = Array.from(this.fileIndex.values()).filter((f) => f.isTestFile);
    const sourceFiles = Array.from(this.fileIndex.values()).filter((f) => !f.isTestFile);

    for (const test of testFiles) {
      const testName = path.basename(test.relativePath).replace(/^(test_|tests_)/, '').replace(/(\.test|\.spec)?\.[^.]+$/, '');
      const matchedSources: string[] = [];

      for (const src of sourceFiles) {
        const srcName = path.basename(src.relativePath).replace(/\.[^.]+$/, '');
        if (srcName === testName || test.relativePath.includes(srcName)) {
          matchedSources.push(src.relativePath);
          const testsForSrc = this.sourceToTestMap.get(src.relativePath) ?? [];
          testsForSrc.push(test.relativePath);
          this.sourceToTestMap.set(src.relativePath, testsForSrc);
        }
      }
      this.testToSourceMap.set(test.relativePath, matchedSources);
    }
  }

  public getFiles(): FileMetadata[] {
    return Array.from(this.fileIndex.values());
  }

  public getFile(relPath: string): FileMetadata | undefined {
    return this.fileIndex.get(relPath);
  }

  public findSymbols(query: string): CodeSymbol[] {
    const lower = query.toLowerCase();
    const results: CodeSymbol[] = [];
    for (const [name, syms] of this.symbolIndex.entries()) {
      if (name.toLowerCase().includes(lower)) {
        results.push(...syms);
      }
    }
    return results;
  }

  public getTestsForSource(srcRelPath: string): string[] {
    return this.sourceToTestMap.get(srcRelPath) ?? [];
  }

  public getSourcesForTest(testRelPath: string): string[] {
    return this.testToSourceMap.get(testRelPath) ?? [];
  }

  public getStructureSummary(): {
    totalFiles: number;
    totalSymbols: number;
    languages: Record<string, number>;
  } {
    const languages: Record<string, number> = {};
    for (const file of this.fileIndex.values()) {
      languages[file.language] = (languages[file.language] ?? 0) + 1;
    }
    return {
      totalFiles: this.fileIndex.size,
      totalSymbols: Array.from(this.symbolIndex.values()).reduce((a, b) => a + b.length, 0),
      languages,
    };
  }
}
