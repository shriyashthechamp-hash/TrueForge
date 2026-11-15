# FORGE//SENTINEL
### Repository-Intelligent, Safety-First AI Coding Agent for Visual Studio Code
**Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27**

> *"Understand First. Plan Intelligently. Change Precisely. Prove Everything."*

---

## 1. Product Philosophy & Overview

**FORGE//SENTINEL** is not a chatbot wrapper or superficial AI assistant. It is a precision engineering command center integrated into Visual Studio Code, built on the official **TrueFoundry TrueForge** agent harness.

Most AI coding tools modify repositories blindly, hallucinating imports, introducing unintended regressions, and overwriting files without audit trails. FORGE//SENTINEL establishes a strict safety-first paradigm:
1. **Understand First**: Deep repository structure, AST symbols, dependencies, and test mappings are discovered via **CODEBASE MRI** before any edit is planned.
2. **Plan Intelligently**: Multi-factor relevance scoring (**CONTEXT AUCTION**) allocates high-value context within a configurable token budget, providing a transparent Context Selection Receipt.
3. **Change Precisely**: Minimal, surgical patches (**SURGICAL AI**) are proposed with documented purpose, rationale, and impact analysis.
4. **Prove Everything**: Human-in-the-loop hunk-by-hunk review (**DIFF REVIEW**), transactional staging with conflict detection (**TIME MACHINE**), and real test verification (**PROOF-CARRYING CODE**).

---

## 2. The Six Integrated Subsystems

```
+-----------------------------------------------------------------------------+
|                               FORGE//SENTINEL                               |
+-----------------------------------------------------------------------------+
  |-- SYSTEM 01: CODEBASE MRI (Structural intelligence, symbols, test mapping)
  |-- SYSTEM 02: CONTEXT AUCTION (Intelligent retrieval & token budgeting)
  |-- SYSTEM 03: SURGICAL AI (Precision-first patch synthesis & impact analysis)
  |-- SYSTEM 04: PROOF-CARRYING CODE (Automated test verification & proofs)
  |-- SYSTEM 05: TIME MACHINE & FLIGHT RECORDER (Staged patches, undo, audit)
  |-- SYSTEM 06: MODEL RESCUE (Failover, backoff, and state preservation)
```

1. **System 01 — Codebase MRI**: Parses AST functions, classes, imports, and cross-references. Automatically correlates source code with associated test suites.
2. **System 02 — Context Auction**: Ranks candidate context using explicit mentions (`@file`, `@symbol`), symbol call proximity, BM25 frequency, and test proximity. Outputs a complete **Context Selection Receipt** JSON.
3. **System 03 — Surgical AI**: Restricts modifications to staged patches with verified rationale. Zero silent writes.
4. **System 04 — Proof-Carrying Code**: Runs actual tests via controlled execution, capturing real exit codes and stdout/stderr before generating verified proof reports.
5. **System 05 — Time Machine & Flight Recorder**: Captures initial workspace state, stages diff hunks in memory, detects concurrent external modifications via SHA-256 validation, and enables full undo via native `vscode.WorkspaceEdit`.
6. **System 06 — Model Rescue**: Transparently recovers from transient network drops or provider timeouts with bounded exponential backoff.

---

## 3. Official Competition Capabilities

| Capability | Implementation |
|---|---|
| **Inline Edit** | `Cmd+Shift+K` (macOS) / `Ctrl+Shift+K` (Windows/Linux) invokes surgical inline edits on selected code, presenting a native VS Code diff review. |
| **Agent Mode** | Dedicated Sentinel Command Center sidebar panel. A single prompt drives TrueForge's autonomous agent loop across tools to modify multiple files. |
| **Context Assembly** | Seamless `@file` and `@symbol` parsing with automated repository retrieval and strict token budget enforcement. |
| **Diff Review** | Native `vscode.diff` side-by-side comparison with hunk-level accept and reject capabilities. |
| **Streaming & Cancellation** | Full Server-Sent Events (SSE) streaming with immediate abort via `AbortController` and `vscode.CancellationToken`. |

---

## 4. MCP Tool Architecture

FORGE//SENTINEL embeds a local Model Context Protocol (MCP) server on port `9099` connected to TrueForge via SSE:

- **Read Tools**: `read_file`, `list_workspace_files`, `search_workspace`, `find_symbol`, `inspect_file_structure`, `retrieve_code_context`.
- **Proposal Tools**: `propose_file_edit`, `propose_multi_file_edit`, `get_staged_patches`.
- **Execution Tools**: `run_terminal_command`, `run_test_command`.

All file paths are strictly bounded to the workspace root; path traversals are rejected with security exceptions.

---

## 5. Local Setup & Quickstart

### Prerequisites
- Node.js >= 20.0.0
- pnpm >= 10.0.0 or npm >= 10.0.0
- Python >= 3.10 (for running Python testbeds)
- Visual Studio Code

### 1. Start Local TrueForge Harness Server
From the root workspace:
```bash
# Start standalone TrueForge daemon (SQLite mode on localhost:8790)
node trueforge/packages/trueforge/dist/cli.js --port 8790
```
Verify TrueForge is running:
```bash
curl http://localhost:8790/healthz
# Returns: {"status":"ok","version":"0.0.0"}
```

### 2. Configure Model Provider in TrueForge
Open TrueForge (or configure via HTTP API) to set up your preferred model provider (OpenAI, Anthropic, Google Gemini, or local OpenAI-compatible endpoint). FORGE//SENTINEL does not store or handle any model API keys.

### 3. Build & Test FORGE//SENTINEL
```bash
cd FORGE-SENTINEL
npm install
npm run build
npm test
```

### 4. Run Extension in VS Code
Open `FORGE-SENTINEL` in VS Code and press `F5` to launch an Extension Development Host.

---

## 6. Upstream Attribution & Licenses
- **TrueForge**: Copyright (c) TrueFoundry. Licensed under the MIT License.
- **Flask**: Copyright (c) Pallets Projects. Licensed under the BSD-3-Clause License. Pinned to tag `3.1.3` (commit `22d92470`).
- **FORGE//SENTINEL**: Licensed under the MIT License.
