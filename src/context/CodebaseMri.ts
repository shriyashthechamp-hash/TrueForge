import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CodeSymbol, CodebaseMriSummary, FileMetadata, ImportRelationship } from '../shared/types.js';

export class CodebaseMri {
  private fileIndex = new Map<string, FileMetadata>();
  private symbolIndex = new Map<string, CodeSymbol[]>();
  private testToSourceMap = new Map<string, string[]>();
  private sourceToTestMap = new Map<string, string[]>();
  private importGraph = new Map<string, string[]>(); // file -> files it imports
  private reverseImportGraph = new Map<string, string[]>(); // file -> files that import it
  private symbolReferences = new Map<string, Set<string>>(); // symbol -> files referencing it
  private isScanning = false;
  private lastScannedMs = 0;

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
    '.next',
    '.turbo',
  ]);

  private readonly SUPPORTED_EXTS = new Set([
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

  constructor(private readonly workspaceRoot: string) {}

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public getLastScannedMs(): number {
    return this.lastScannedMs;
  }

  /**
   * Full repository scan and graph reconstruction
   */
  public async scan(): Promise<Map<string, FileMetadata>> {
    this.isScanning = true;
    try {
      this.fileIndex.clear();
      this.symbolIndex.clear();
      this.testToSourceMap.clear();
      this.sourceToTestMap.clear();
      this.importGraph.clear();
      this.reverseImportGraph.clear();
      this.symbolReferences.clear();

      await this.scanDirectory(this.workspaceRoot);
      this.reconstructGraphs();
      this.lastScannedMs = Date.now();
      return this.fileIndex;
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Incremental refresh: refreshes only files that have been modified or created since last scan.
   */
  public async refreshIncremental(): Promise<{ updated: string[]; removed: string[] }> {
    const updated: string[] = [];
    const removed: string[] = [];
    const seenPaths = new Set<string>();

    const checkDir = async (dirPath: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await fs.readdir(dirPath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (this.IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
        const fullPath = path.join(dirPath, entry);
        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          await checkDir(fullPath);
        } else if (stat.isFile()) {
          const relPath = path.relative(this.workspaceRoot, fullPath);
          seenPaths.add(relPath);
          const existing = this.fileIndex.get(relPath);
          if (!existing || stat.mtimeMs > existing.lastModifiedMs) {
            await this.refreshFile(fullPath);
            updated.push(relPath);
          }
        }
      }
    };

    await checkDir(this.workspaceRoot);

    for (const relPath of this.fileIndex.keys()) {
      if (!seenPaths.has(relPath)) {
        this.removeFile(relPath);
        removed.push(relPath);
      }
    }

    if (updated.length > 0 || removed.length > 0) {
      this.reconstructGraphs();
      this.lastScannedMs = Date.now();
    }

    return { updated, removed };
  }

  /**
   * Incremental refresh of a single file
   */
  public async refreshFile(filePath: string): Promise<FileMetadata | undefined> {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workspaceRoot, filePath);
    const relPath = path.relative(this.workspaceRoot, absPath);

    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      this.removeFile(relPath);
      return undefined;
    }

    // Clear old symbols for this file
    for (const [symName, list] of this.symbolIndex.entries()) {
      const filtered = list.filter((s) => s.filePath !== relPath);
      if (filtered.length === 0) {
        this.symbolIndex.delete(symName);
      } else {
        this.symbolIndex.set(symName, filtered);
      }
    }

    const meta = await this.indexFile(absPath, stat.size, stat.mtimeMs);
    return meta;
  }

  /**
   * Removes a file from all indexes
   */
  public removeFile(relPath: string): void {
    this.fileIndex.delete(relPath);
    for (const [symName, list] of this.symbolIndex.entries()) {
      const filtered = list.filter((s) => s.filePath !== relPath);
      if (filtered.length === 0) {
        this.symbolIndex.delete(symName);
      } else {
        this.symbolIndex.set(symName, filtered);
      }
    }
    this.importGraph.delete(relPath);
    this.reverseImportGraph.delete(relPath);
    this.testToSourceMap.delete(relPath);
    this.sourceToTestMap.delete(relPath);
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

  public async indexFile(
    fullPath: string,
    sizeBytes?: number,
    mtimeMs?: number
  ): Promise<FileMetadata | undefined> {
    const relativePath = path.relative(this.workspaceRoot, fullPath);
    const ext = path.extname(fullPath).toLowerCase();

    // Never index environment or secret key files
    const baseLower = path.basename(fullPath).toLowerCase();
    if (baseLower === '.env' || baseLower.startsWith('.env.') || baseLower.endsWith('.pem') || baseLower.endsWith('.key')) {
      if (baseLower !== '.env.example') {
        return undefined;
      }
    }

    if (!this.SUPPORTED_EXTS.has(ext)) {
      return undefined;
    }

    // Skip very large files (> 1MB) to protect extension performance
    if (sizeBytes && sizeBytes > 1024 * 1024) {
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
      sizeBytes: sizeBytes ?? Buffer.byteLength(content, 'utf8'),
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
      case '.py':
        return 'python';
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
        return 'javascript';
      case '.json':
        return 'json';
      case '.md':
      case '.rst':
        return 'markdown';
      case '.html':
        return 'html';
      case '.css':
        return 'css';
      default:
        return 'text';
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
      const jsInterfaceRegex = /^\s*(?:export\s+)?interface\s+([a-zA-Z0-9_]+)/;
      const jsTypeRegex = /^\s*(?:export\s+)?type\s+([a-zA-Z0-9_]+)\s*=/;

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
          continue;
        }
        const ifaceMatch = line.match(jsInterfaceRegex);
        if (ifaceMatch) {
          symbols.push({
            name: ifaceMatch[1],
            kind: 'interface',
            filePath,
            startLine: i + 1,
            endLine: i + 1,
          });
          continue;
        }
        const typeMatch = line.match(jsTypeRegex);
        if (typeMatch) {
          symbols.push({
            name: typeMatch[1],
            kind: 'type',
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

  /**
   * Reconstructs import graphs, symbol cross-references, and test relationships
   */
  private reconstructGraphs(): void {
    this.importGraph.clear();
    this.reverseImportGraph.clear();
    this.testToSourceMap.clear();
    this.sourceToTestMap.clear();

    const allFiles = Array.from(this.fileIndex.values());

    // 1. Build Import Graph
    for (const file of allFiles) {
      const resolvedImports: string[] = [];
      for (const imp of file.imports) {
        const resolved = this.resolveImportToWorkspaceFile(file.relativePath, imp);
        if (resolved && resolved !== file.relativePath) {
          resolvedImports.push(resolved);
          const dependents = this.reverseImportGraph.get(resolved) ?? [];
          dependents.push(file.relativePath);
          this.reverseImportGraph.set(resolved, Array.from(new Set(dependents)));
        }
      }
      this.importGraph.set(file.relativePath, Array.from(new Set(resolvedImports)));
    }

    // 2. Correlate Tests and Sources (Heuristics + Import Graph)
    const testFiles = allFiles.filter((f) => f.isTestFile);
    const sourceFiles = allFiles.filter((f) => !f.isTestFile);

    for (const test of testFiles) {
      const matchedSources = new Set<string>();

      // Heuristic matching via file name
      const testName = path
        .basename(test.relativePath)
        .replace(/^(test_|tests_)/, '')
        .replace(/(\.test|\.spec)?\.[^.]+$/, '');

      for (const src of sourceFiles) {
        const srcName = path.basename(src.relativePath).replace(/\.[^.]+$/, '');
        if (srcName === testName || test.relativePath.includes(srcName)) {
          matchedSources.add(src.relativePath);
        }
      }

      // Graph-based matching: if test imports source
      const testImports = this.importGraph.get(test.relativePath) ?? [];
      for (const impPath of testImports) {
        if (!this.fileIndex.get(impPath)?.isTestFile) {
          matchedSources.add(impPath);
        }
      }

      const sourcesList = Array.from(matchedSources);
      this.testToSourceMap.set(test.relativePath, sourcesList);

      for (const srcPath of sourcesList) {
        const testsForSrc = this.sourceToTestMap.get(srcPath) ?? [];
        testsForSrc.push(test.relativePath);
        this.sourceToTestMap.set(srcPath, Array.from(new Set(testsForSrc)));
      }
    }
  }

  private resolveImportToWorkspaceFile(importerRelPath: string, rawImport: string): string | undefined {
    // Relative imports e.g. './helpers' or '../diff/PatchStagingManager.js'
    if (rawImport.startsWith('.')) {
      const importerDir = path.dirname(importerRelPath);
      const cleanTarget = rawImport.replace(/\.(js|ts|jsx|tsx)$/, '');
      const candidateBase = path.normalize(path.join(importerDir, cleanTarget));

      for (const ext of ['.py', '.ts', '.js', '.tsx', '.jsx']) {
        const candidate = candidateBase + ext;
        if (this.fileIndex.has(candidate)) return candidate;
      }
      // Check index file e.g. dir/index.ts
      for (const ext of ['.py', '.ts', '.js']) {
        const candidate = path.join(candidateBase, `index${ext}`);
        if (this.fileIndex.has(candidate)) return candidate;
      }
      return undefined;
    }

    // Python package imports e.g. 'flask.helpers' or 'flask.cli'
    const pyPath = rawImport.replace(/\./g, '/');
    for (const ext of ['.py', '']) {
      for (const [knownPath] of this.fileIndex.entries()) {
        if (knownPath.endsWith(pyPath + ext) || knownPath.includes(pyPath)) {
          return knownPath;
        }
      }
    }

    return undefined;
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

  public getImportedFiles(filePath: string): string[] {
    return this.importGraph.get(filePath) ?? [];
  }

  public getDependentFiles(filePath: string): string[] {
    return this.reverseImportGraph.get(filePath) ?? [];
  }

  public getTestsForSource(srcRelPath: string): string[] {
    return this.sourceToTestMap.get(srcRelPath) ?? [];
  }

  public getSourcesForTest(testRelPath: string): string[] {
    return this.testToSourceMap.get(testRelPath) ?? [];
  }

  public getStructureSummary(): CodebaseMriSummary {
    const languages: Record<string, number> = {};
    for (const file of this.fileIndex.values()) {
      languages[file.language] = (languages[file.language] ?? 0) + 1;
    }

    return {
      totalFiles: this.fileIndex.size,
      totalSymbols: Array.from(this.symbolIndex.values()).reduce((a, b) => a + b.length, 0),
      languages,
      lastScannedMs: this.lastScannedMs,
      isStale: false,
      staleFilesCount: 0,
    };
  }
}
