/**
 * FORGE//SENTINEL Core Shared Types & Contracts
 */

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "variable" | "interface" | "type" | "unknown";
  filePath: string;
  startLine: number;
  endLine: number;
  documentation?: string;
}

export interface FileMetadata {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  lastModifiedMs: number;
  language: string;
  isTestFile: boolean;
  imports: string[];
  symbols: CodeSymbol[];
}

export interface ContextAuctionCandidate {
  filePath: string;
  startLine?: number;
  endLine?: number;
  score: number;
  matchedKeywords: string[];
  matchedSymbols: string[];
  relevanceRationale: string;
  estimatedTokens: number;
  snippet?: string;
}

export interface ContextSelectionReceipt {
  query: string;
  timestamp: string;
  tokenBudget: number;
  totalTokensUsed: number;
  selectedFiles: ContextAuctionCandidate[];
  excludedFiles: {
    filePath: string;
    score: number;
    exclusionReason: string;
  }[];
  retrievalStrategy: "hybrid-symbol-bm25";
}

export interface DiffHunk {
  hunkId: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
  accepted?: boolean;
}

export interface StagedFilePatch {
  patchId: string;
  filePath: string;
  absolutePath: string;
  originalSha256: string;
  proposedSha256: string;
  originalContent: string;
  proposedContent: string;
  unifiedDiff: string;
  hunks: DiffHunk[];
  purpose: string;
  rationale: string;
  expectedImpact: string;
  riskLevel: "low" | "medium" | "high";
  status: "staged" | "accepted" | "rejected" | "applied" | "reverted";
  createdAt: string;
}

export interface ProofOfChangeReport {
  taskId: string;
  userInstruction: string;
  filesModified: string[];
  patchesProposed: number;
  patchesAccepted: number;
  testsDiscovered: string[];
  testsExecuted: string[];
  testsPassed: boolean;
  testOutputSummary: string;
  status: "success" | "partial" | "failed" | "unverified";
  generatedAt: string;
}

export interface FlightRecorderEvent {
  id: string;
  timestamp: string;
  type: "turn_start" | "model_stream" | "tool_call" | "tool_approval" | "tool_result" | "patch_staged" | "patch_applied" | "turn_done" | "error";
  summary: string;
  details?: Record<string, unknown>;
}
