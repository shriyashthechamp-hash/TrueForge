# FORGE//SENTINEL — ARCHITECTURE SPECIFICATION
## Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27
### "Understand First. Plan Intelligently. Change Precisely. Prove Everything."

---

## 1. Executive Summary & Core Tenets

**FORGE//SENTINEL** is a repository-intelligent, safety-first AI coding agent engineered for Visual Studio Code. Rather than acting as a chatbot wrapper or executing unvetted, destructive writes directly into user filesystems, FORGE//SENTINEL functions as an engineering command center that:
1. Performs deep structural reconnaissance (**CODEBASE MRI**) of the repository before suggesting any modification.
2. Intelligently filters and budget-allocates context (**CONTEXT AUCTION**) using multi-dimensional relevance scoring.
3. Proposes surgical, minimal, unified patch proposals (**SURGICAL AI**) with clear intent and impact analysis.
4. Demands explicit human-in-the-loop hunk-by-hunk review and verification (**DIFF REVIEW** & **PROOF-CARRYING CODE**).
5. Provides transactional staging, non-destructive rollbacks, and full event auditing (**TIME MACHINE & FLIGHT RECORDER**).
6. Ensures rock-solid resilience against network, provider, or tool failures (**MODEL RESCUE**).

---

## 2. System Architecture & Component Topology

```
+-----------------------------------------------------------------------------------+
|                            VS CODE RUNTIME / EXTENSION                            |
|                                                                                   |
|  +---------------------------+   +-----------------------+   +-----------------+  |
|  | Sentinel Sidebar & Panels |   | Inline Edit Controller|   | Diff Review     |  |
|  | - Agent Command Center    |   | - Cmd+Shift+K Trigger |   | - Native Editor |  |
|  | - Codebase MRI Explorer   |   | - Range & Context Grab|   | - Hunk Decision |  |
|  | - Flight Recorder Log     |   | - Inline Diff Overlay |   | - Undo Stack    |  |
|  +-------------+-------------+   +-----------+-----------+   +--------+--------+  |
|                |                             |                        |           |
|                +--------------------+--------+------------------------+           |
|                                     |                                             |
|                     +---------------v---------------+                             |
|                     |     Extension Core Engine     |                             |
|                     | - Session State Manager       |                             |
|                     | - Transactional Patch Staging |                             |
|                     | - Context Selection Auction   |                             |
|                     | - Codebase MRI Indexer        |                             |
|                     +---------------+---------------+                             |
|                                     |                                             |
|                     +---------------v---------------+                             |
|                     |  Sentinel Local MCP Server    |                             |
|                     |  (HTTP/SSE on localhost:9099) |                             |
|                     |  - read_file                  |                             |
|                     |  - search_workspace           |                             |
|                     |  - find_symbol                |                             |
|                     |  - propose_file_edit          |                             |
|                     |  - run_terminal_command       |                             |
|                     +---------------+---------------+                             |
+-------------------------------------|---------------------------------------------+
                                      | MCP Protocol (SSE / HTTP)
                                      v
+-----------------------------------------------------------------------------------+
|                        TRUEFORGE AGENT HARNESS (LOCAL)                            |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  | Hono HTTP & SSE Server (localhost:8790)                                     |  |
|  | - /api/v1/sessions (Session Lifecycle, Grants, Events)                      |  |
|  | - /api/v1/sessions/{id}/turns (Agent Turn Streaming & Event Handling)       |  |
|  | - /api/v1/settings/mcp-servers (Remote MCP Server Registration)             |  |
|  +-------------------------------------+---------------------------------------+  |
|                                        |                                          |
|  +-------------------------------------v---------------------------------------+  |
|  | Autonomous Agent Execution Loop                                             |  |
|  | - Model Calls (OpenAI / Anthropic / Gemini / Local through TrueForge)       |  |
|  | - Tool Calling Engine & Deferred Resolution                                 |  |
|  | - Human Approval Checkpoints (tool.approval_required)                       |  |
|  | - Thread Compaction & Token Optimization                                    |  |
|  +-------------------------------------+---------------------------------------+  |
|                                        |                                          |
|  +-------------------------------------v---------------------------------------+  |
|  | Persistence & State Layer                                                   |  |
|  | - SQLite Store (Standalone Mode)                                            |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 3. The Six Subsystems

### SYSTEM 01: CODEBASE MRI (Repository Intelligence)
- **Objective**: Discover code layout, modules, AST symbols, function/class definitions, and imports before modifications occur.
- **Components**:
  - `WorkspaceScanner`: Traverses workspace files respecting `.gitignore` and binary ignore filters.
  - `SymbolExtractor`: Leverages TypeScript AST parser / regex language heuristics to map functions, classes, and exported constants.
  - `DependencyGraph`: Maps intra-workspace file imports and test-to-source relationships.
  - `MriCache`: Memory-efficient indexing with incremental invalidation on `vscode.workspace.onDidChangeTextDocument`.

### SYSTEM 02: CONTEXT AUCTION (Context Selection & Budgeting)
- **Objective**: Rank and select the highest-value code segments within a configurable token budget (e.g. 8k, 16k, 32k tokens).
- **Scoring Pipeline**:
  - **Explicit Mentions (`@file`, `@symbol`)**: Weight 1.0 (Mandatory inclusion).
  - **Lexical BM25 / Keyword Frequency**: Weight 0.35.
  - **Import Proximity / Call Distance**: Weight 0.30.
  - **Test Affinity**: Weight 0.20.
  - **Active Editor / Selection Focus**: Weight 0.15.
- **Context Selection Receipt**: Produces a structured JSON audit trail detailing candidate files, scored tokens, included snippets with line numbers, and excluded files with explanations.

### SYSTEM 03: SURGICAL AI (Precision Modification Engine)
- **Objective**: Synthesize atomic, reviewable patches that minimize extraneous churn and preserve coding conventions.
- **Contract**:
  - Agent interacts exclusively through `propose_file_edit` or `propose_multi_file_edit` tools.
  - Tools produce structured unified diff patches stored in the `PatchStagingManager`.
  - Every modification includes: `purpose`, `rationale`, `expectedImpact`, `riskLevel`, and `testsDiscovered`.

### SYSTEM 04: PROOF-CARRYING CODE (Verification Engine)
- **Objective**: Back every proposed change with executed evidence.
- **Workflow**:
  1. Detect relevant tests (e.g. `pytest tests/test_cli.py -k test_config`).
  2. Execute commands inside the controlled terminal runner (`run_test_command`).
  3. Capture exit code, stdout, stderr, execution duration.
  4. Generate a "Proof of Change" report displaying passing tests and verified behaviors. Never claim success without genuine execution.

### SYSTEM 05: TIME MACHINE & FLIGHT RECORDER (Safety & Auditability)
- **Objective**: Ensure transactional safety, hunk-level diff acceptance, and comprehensive execution observability.
- **Safety Guarantees**:
  - **Staged Storage**: Proposed modifications reside in virtual memory / staged patch registry until explicit user approval.
  - **Conflict Detection**: Checks file SHA-256 before applying patch; halts if the underlying file was changed externally.
  - **Native VS Code WorkspaceEdit**: Uses `vscode.workspace.applyEdit` so accepted changes are recorded on the native undo stack (`Cmd+Z`).
  - **Flight Recorder**: Real-time structured event log capturing all TrueForge events (`model.message`, `tool.call`, `tool.approval_required`, `tool.response`, `turn.done`).

### SYSTEM 06: MODEL RESCUE (Resilience Layer)
- **Objective**: Prevent dropped turns, network drops, and corrupted state.
- **Capabilities**:
  - Bounded exponential backoff retry for transient HTTP/SSE network disconnections.
  - Clear user diagnostics on unreachable TrueForge server or missing model provider credentials.
  - Strict preservation of workspace state during aborts or cancellations.

---

## 4. MCP Tool Contracts

The local Sentinel MCP Server exposes the following standard tools to TrueForge:

| Tool Name | Type | Description |
|-----------|------|-------------|
| `read_file` | Read | Read file contents with line offset and limit. Prevents path traversal outside workspace. |
| `list_workspace_files` | Read | List workspace directory structure matching glob patterns. |
| `search_workspace` | Read | Fast lexical regex/string search across workspace files. |
| `find_symbol` | Read | Find symbol definitions, functions, and classes across the codebase. |
| `retrieve_code_context` | Read | Execute Context Auction to retrieve optimal context bundle for a prompt. |
| `propose_file_edit` | Write | Stage a single-file replacement or unified patch with rationale. Pauses for user approval. |
| `propose_multi_file_edit` | Write | Stage coordinated multi-file patch across repository components. |
| `run_terminal_command` | Execute | Execute command in workspace terminal sandbox with captured stdout/stderr. |
| `run_test_command` | Execute | Run automated test suite and capture exit code and test output. |
| `get_staged_patches` | Inspect | Inspect all currently staged patches awaiting review. |
| `apply_staged_patch` | Execute | Apply approved patch hunks to workspace via `WorkspaceEdit`. |
| `undo_patch` | Execute | Revert applied patch safely. |

---

## 5. Security Architecture

1. **Path Traversal Prevention**: Every requested path is resolved against `vscode.workspace.workspaceFolders[0].uri.fsPath`. Paths resolving outside the root throw `SecurityException`.
2. **Safe Terminal Execution**: Commands are executed with cwd restricted to workspace root. Dangerous patterns (`rm -rf /`, formatting commands) are blocked.
3. **Model Decoupling**: No LLM API keys are handled or stored in the extension. The extension communicates solely with the local TrueForge daemon.
