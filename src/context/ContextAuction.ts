import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContextAuctionCandidate, ContextSelectionReceipt, FileMetadata } from '../shared/types.js';
import type { CodebaseMri } from './CodebaseMri.js';

export class ContextAuction {
  constructor(
    private readonly workspaceRoot: string,
    private readonly mri: CodebaseMri,
    private defaultTokenBudget = 16000
  ) {}

  public estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public parseExplicitMentions(query: string): {
    cleanedQuery: string;
    explicitFiles: string[];
    explicitSymbols: string[];
  } {
    const explicitFiles: string[] = [];
    const explicitSymbols: string[] = [];

    const fileRegex = /@file:([^\s]+)/g;
    let match;
    while ((match = fileRegex.exec(query)) !== null) {
      explicitFiles.push(match[1]);
    }

    const symbolRegex = /@symbol:([^\s]+)/g;
    while ((match = symbolRegex.exec(query)) !== null) {
      explicitSymbols.push(match[1]);
    }

    const cleanedQuery = query.replace(fileRegex, '').replace(symbolRegex, '').trim();
    return { cleanedQuery, explicitFiles, explicitSymbols };
  }

  public async runAuction(
    query: string,
    budgetOverride?: number
  ): Promise<{ receipt: ContextSelectionReceipt; contextBundle: string }> {
    const tokenBudget = budgetOverride ?? this.defaultTokenBudget;
    const { cleanedQuery, explicitFiles, explicitSymbols } = this.parseExplicitMentions(query);

    const queryTokens = cleanedQuery
      .toLowerCase()
      .split(/[^a-zA-Z0-9_]+/)
      .filter((t) => t.length > 2);

    const files = this.mri.getFiles();
    const scoredCandidates: ContextAuctionCandidate[] = [];

    for (const file of files) {
      let score = 0;
      const matchedKeywords: string[] = [];
      const matchedSymbols: string[] = [];
      let rationaleParts: string[] = [];

      const isExplicitFile = explicitFiles.some((ef) =>
        file.relativePath.toLowerCase().endsWith(ef.toLowerCase())
      );
      if (isExplicitFile) {
        score += 1000;
        rationaleParts.push('Explicit user @file reference');
      }

      for (const sym of file.symbols) {
        const isExplicitSym = explicitSymbols.some(
          (es) => sym.name.toLowerCase() === es.toLowerCase()
        );
        if (isExplicitSym) {
          score += 500;
          matchedSymbols.push(sym.name);
          rationaleParts.push(`Defines explicit symbol @symbol:${sym.name}`);
        } else if (queryTokens.includes(sym.name.toLowerCase())) {
          score += 50;
          matchedSymbols.push(sym.name);
          rationaleParts.push(`Symbol "${sym.name}" matches query token`);
        }
      }

      const filePathLower = file.relativePath.toLowerCase();
      for (const token of queryTokens) {
        if (filePathLower.includes(token)) {
          score += 30;
          matchedKeywords.push(token);
        }
      }

      if (matchedSymbols.length > 0 || isExplicitFile) {
        const linkedTests = this.mri.getTestsForSource(file.relativePath);
        if (linkedTests.length > 0) {
          score += 15;
          rationaleParts.push(`Associated with tests: ${linkedTests.slice(0, 2).join(', ')}`);
        }
      }

      if (score > 0) {
        const estTokens = this.estimateTokens(
          `// File: ${file.relativePath}\n` + (await this.peekFileContent(file.absolutePath))
        );

        scoredCandidates.push({
          filePath: file.relativePath,
          score,
          matchedKeywords: Array.from(new Set(matchedKeywords)),
          matchedSymbols: Array.from(new Set(matchedSymbols)),
          relevanceRationale: rationaleParts.join('; ') || 'Lexical and symbol match',
          estimatedTokens: estTokens,
        });
      }
    }

    scoredCandidates.sort((a, b) => b.score - a.score);

    let tokensUsed = 0;
    const selectedFiles: ContextAuctionCandidate[] = [];
    const excludedFiles: { filePath: string; score: number; exclusionReason: string }[] = [];
    const bundleChunks: string[] = [];

    for (const candidate of scoredCandidates) {
      if (tokensUsed + candidate.estimatedTokens <= tokenBudget) {
        let content = '';
        try {
          content = await fs.readFile(path.resolve(this.workspaceRoot, candidate.filePath), 'utf8');
        } catch {
          continue;
        }

        tokensUsed += candidate.estimatedTokens;
        candidate.snippet = content;
        selectedFiles.push(candidate);
        bundleChunks.push(
          `--- FILE: ${candidate.filePath} ---\n${content}\n--- END FILE: ${candidate.filePath} ---`
        );
      } else {
        excludedFiles.push({
          filePath: candidate.filePath,
          score: candidate.score,
          exclusionReason: `Context budget exhausted (requires ~${candidate.estimatedTokens} tokens; remaining budget: ${tokenBudget - tokensUsed})`,
        });
      }
    }

    const receipt: ContextSelectionReceipt = {
      query,
      timestamp: new Date().toISOString(),
      tokenBudget,
      totalTokensUsed: tokensUsed,
      selectedFiles,
      excludedFiles,
      retrievalStrategy: 'hybrid-symbol-bm25',
    };

    return { receipt, contextBundle: bundleChunks.join('\n\n') };
  }

  private async peekFileContent(absPath: string): Promise<string> {
    try {
      const content = await fs.readFile(absPath, 'utf8');
      return content.slice(0, 4000);
    } catch {
      return '';
    }
  }
}
