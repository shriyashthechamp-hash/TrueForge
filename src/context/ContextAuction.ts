import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CodeSymbol,
  ContextAuctionCandidate,
  ContextSelectionReceipt,
  FileMetadata,
} from '../shared/types.js';
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

  /**
   * Runs the multi-factor Context Auction algorithm with responsible token budgeting,
   * capacity reservation for system prompt and output, and relevance thresholding.
   */
  public async runAuction(
    query: string,
    budgetOverride?: number,
    options?: {
      reservedInstructionsTokens?: number;
      reservedOutputTokens?: number;
      maxSelectedFiles?: number;
      minRelevanceScore?: number;
    }
  ): Promise<{ receipt: ContextSelectionReceipt; contextBundle: string }> {
    const totalBudget = budgetOverride ?? this.defaultTokenBudget;

    // Reserve capacity for system prompt/tools and LLM output generation
    // For small test budgets (< 1000 tokens), allocate 100% to code so micro-budgets work predictably
    const isMicroBudget = totalBudget < 1000;
    const reservedInstructions = isMicroBudget
      ? 0
      : (options?.reservedInstructionsTokens ?? (totalBudget >= 8000 ? 1500 : Math.round(totalBudget * 0.2)));
    const reservedOutput = isMicroBudget
      ? 0
      : (options?.reservedOutputTokens ?? (totalBudget >= 8000 ? 3500 : Math.round(totalBudget * 0.3)));
    const codeBudget = isMicroBudget
      ? totalBudget
      : Math.max(100, Math.min(totalBudget, totalBudget - reservedInstructions - reservedOutput));
    const maxFiles = options?.maxSelectedFiles ?? 15;
    const minScore = options?.minRelevanceScore ?? 35;

    const { cleanedQuery, explicitFiles, explicitSymbols } = this.parseExplicitMentions(query);

    const queryTokens = cleanedQuery
      .toLowerCase()
      .split(/[^a-zA-Z0-9_]+/)
      .filter((t) => t.length > 2);

    const files = this.mri.getFiles();
    const candidateMap = new Map<string, { candidate: ContextAuctionCandidate; fileMeta: FileMetadata }>();

    // 1. Initial Lexical & Symbol Scoring Pass
    for (const file of files) {
      let score = 0;
      const matchedKeywords: string[] = [];
      const matchedSymbols: string[] = [];
      const rationaleParts: string[] = [];

      // A. Explicit File References (@file:...)
      const isExplicitFile = explicitFiles.some((ef) =>
        file.relativePath.toLowerCase().endsWith(ef.toLowerCase())
      );
      if (isExplicitFile) {
        score += 1000;
        rationaleParts.push('Explicit user @file reference (+1000)');
      }

      // B. Symbol Matches
      for (const sym of file.symbols) {
        const isExplicitSym = explicitSymbols.some(
          (es) => sym.name.toLowerCase() === es.toLowerCase()
        );
        if (isExplicitSym) {
          score += 500;
          matchedSymbols.push(sym.name);
          rationaleParts.push(`Explicit @symbol:${sym.name} (+500)`);
        } else if (queryTokens.includes(sym.name.toLowerCase())) {
          score += 80;
          matchedSymbols.push(sym.name);
          rationaleParts.push(`Symbol "${sym.name}" matches query token (+80)`);
        }
      }

      // C. Lexical Path & Filename Matches
      const filePathLower = file.relativePath.toLowerCase();
      const baseNameLower = path.basename(filePathLower);
      for (const token of queryTokens) {
        if (baseNameLower.includes(token)) {
          score += 50;
          matchedKeywords.push(token);
        } else if (filePathLower.includes(token)) {
          score += 20;
          matchedKeywords.push(token);
        }
      }

      // D. Test-to-Source Link Boost
      if (matchedSymbols.length > 0 || isExplicitFile) {
        const linkedTests = this.mri.getTestsForSource(file.relativePath);
        if (linkedTests.length > 0) {
          score += 30;
          rationaleParts.push(`Linked tests: ${linkedTests.slice(0, 2).join(', ')} (+30)`);
        }
      }

      if (score > 0) {
        candidateMap.set(file.relativePath, {
          candidate: {
            filePath: file.relativePath,
            score,
            matchedKeywords: Array.from(new Set(matchedKeywords)),
            matchedSymbols: Array.from(new Set(matchedSymbols)),
            relevanceRationale: rationaleParts.join('; ') || 'Lexical match',
            estimatedTokens: 0,
          },
          fileMeta: file,
        });
      }
    }

    // 2. Dependency Proximity & Import Boost Pass
    // If File A is high-scoring, files it imports and files that import it get a proximity boost
    const initialScored = Array.from(candidateMap.values()).filter((c) => c.candidate.score >= 50);
    for (const item of initialScored) {
      const importedPaths = this.mri.getImportedFiles(item.candidate.filePath);
      for (const impPath of importedPaths) {
        const target = candidateMap.get(impPath);
        if (target) {
          target.candidate.score += 25;
          target.candidate.relevanceRationale += `; Import neighbor of ${path.basename(item.candidate.filePath)} (+25)`;
        } else {
          const fileMeta = this.mri.getFile(impPath);
          if (fileMeta) {
            candidateMap.set(impPath, {
              candidate: {
                filePath: impPath,
                score: 25,
                matchedKeywords: [],
                matchedSymbols: [],
                relevanceRationale: `Imported by high-relevance file ${path.basename(item.candidate.filePath)} (+25)`,
                estimatedTokens: 0,
              },
              fileMeta,
            });
          }
        }
      }
    }

    // 3. Sub-file Snippet Strategy & Token Budgeting
    const scoredCandidates: ContextAuctionCandidate[] = [];
    for (const { candidate, fileMeta } of candidateMap.values()) {
      let content = '';
      try {
        content = await fs.readFile(fileMeta.absolutePath, 'utf8');
      } catch {
        continue;
      }

      // If file is very large (> 2000 tokens) and not explicitly named, extract symbol-level window
      const fullTokens = this.estimateTokens(content);
      if (fullTokens > 2000 && candidate.matchedSymbols.length > 0 && !candidate.relevanceRationale.includes('@file')) {
        // Extract relevant symbol regions with padding
        const extracted = this.extractSymbolSnippets(content, fileMeta.symbols, candidate.matchedSymbols);
        candidate.snippet = extracted.snippet;
        candidate.startLine = extracted.startLine;
        candidate.endLine = extracted.endLine;
        candidate.estimatedTokens = this.estimateTokens(extracted.snippet);
        candidate.relevanceRationale += ` [Surgically extracted symbol window: lines ${extracted.startLine}-${extracted.endLine}]`;
      } else {
        candidate.snippet = content;
        candidate.estimatedTokens = fullTokens;
      }

      scoredCandidates.push(candidate);
    }

    // Sort by final score descending
    scoredCandidates.sort((a, b) => b.score - a.score);

    // 4. Auction Allocation with Relevance Thresholding and Capacity Reservation
    let tokensUsed = 0;
    const selectedFiles: ContextAuctionCandidate[] = [];
    const excludedFiles: { filePath: string; score: number; exclusionReason: string }[] = [];
    const bundleChunks: string[] = [];

    for (const candidate of scoredCandidates) {
      const isExplicit = candidate.score >= 500;

      // Filter out low-relevance noise unless explicitly requested by user
      if (!isExplicit && candidate.score < minScore) {
        excludedFiles.push({
          filePath: candidate.filePath,
          score: candidate.score,
          exclusionReason: `Low relevance: score (${candidate.score}) below threshold (${minScore})`,
        });
        continue;
      }

      // Respect max files limit for attention sharpness
      if (selectedFiles.length >= maxFiles && !isExplicit) {
        excludedFiles.push({
          filePath: candidate.filePath,
          score: candidate.score,
          exclusionReason: `File limit reached: top ${maxFiles} high-relevance files already selected`,
        });
        continue;
      }

      if (tokensUsed + candidate.estimatedTokens <= codeBudget) {
        tokensUsed += candidate.estimatedTokens;
        selectedFiles.push(candidate);
        const snippetBody = candidate.snippet ?? '';
        bundleChunks.push(
          `--- FILE: ${candidate.filePath}${candidate.startLine ? ` (lines ${candidate.startLine}-${candidate.endLine})` : ''} ---\n${snippetBody}\n--- END FILE: ${candidate.filePath} ---`
        );
      } else {
        excludedFiles.push({
          filePath: candidate.filePath,
          score: candidate.score,
          exclusionReason: `Budget ceiling: requires ~${candidate.estimatedTokens} tokens; remaining capacity is ${codeBudget - tokensUsed} tokens`,
        });
      }
    }

    const receipt: ContextSelectionReceipt = {
      query,
      timestamp: new Date().toISOString(),
      tokenBudget: totalBudget,
      codeBudget,
      reservedCapacity: {
        instructions: reservedInstructions,
        output: reservedOutput,
      },
      totalTokensUsed: tokensUsed,
      selectedFiles,
      excludedFiles,
      retrievalStrategy: 'hybrid-symbol-bm25',
    };

    return { receipt, contextBundle: bundleChunks.join('\n\n') };
  }

  /**
   * Surgically extracts code around matched symbols instead of blasting the entire file
   */
  private extractSymbolSnippets(
    content: string,
    allSymbols: CodeSymbol[],
    matchedSymbolNames: string[]
  ): { snippet: string; startLine: number; endLine: number } {
    const lines = content.split('\n');
    const matched = allSymbols.filter((s) => matchedSymbolNames.includes(s.name));

    if (matched.length === 0) {
      return { snippet: lines.slice(0, 100).join('\n'), startLine: 1, endLine: Math.min(100, lines.length) };
    }

    let minLine = lines.length;
    let maxLine = 1;

    for (const sym of matched) {
      minLine = Math.min(minLine, sym.startLine);
      maxLine = Math.max(maxLine, sym.endLine);
    }

    // Add 15 lines of surrounding context before and after
    const startLine = Math.max(1, minLine - 15);
    const endLine = Math.min(lines.length, maxLine + 30);

    const snippetLines = lines.slice(startLine - 1, endLine);
    return {
      snippet: snippetLines.join('\n'),
      startLine,
      endLine,
    };
  }
}
