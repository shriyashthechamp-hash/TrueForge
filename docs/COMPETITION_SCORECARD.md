# FORGE//SENTINEL — COMPETITION SCORECARD & CAPABILITY AUDIT
## Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27

---

## Evaluation Grid Against Mandatory Competition Requirements

| # | Mandatory Capability | Competition Criteria | FORGE//SENTINEL Implementation | Status |
|---|----------------------|----------------------|--------------------------------|--------|
| 1 | **INLINE EDIT** | User selects code in editor, triggers keybinding, provides natural language, gets real diff in editor, can accept/reject. No copy-paste. | `InlineEditController` (`Cmd+Shift+K`) captures selection, prompts for instruction, stages unified diff, renders native diff editor review. | **Engineered** |
| 2 | **AGENT MODE** | Dedicated agent panel, single natural request drives TrueForge agent loop across tools, discovers files autonomously, modifies ≥ 3 files for Flask task. | Sentinel Command Center Sidebar + `AgentOrchestrator` driven by TrueForge harness + Sentinel MCP Server. Modifies CLI, tests, and docs for Flask task. | **Engineered** |
| 3 | **CONTEXT ASSEMBLY** | Explicit `@file` and `@symbol` mentions, automatic repository retrieval, budget enforcement, displays selection receipt explaining choices. | `CodebaseMri` indexer + `ContextAuction` scoring engine + JSON Context Selection Receipt with explicit token allocations. | **Engineered** |
| 4 | **DIFF REVIEW** | Hunk-by-hunk review, visible before/after, individual accept/reject, no silent writes, applied edits are undoable. | `PatchStagingManager` + `DiffViewer` with hunk-level granularity + `vscode.WorkspaceEdit` integration for native undo. | **Engineered** |
| 5 | **STREAMING & CANCELLATION** | Real streamed TrueForge events, responsive editor UI, instant cancellation, no half-applied edits, workspace consistency preserved. | SSE async stream reader + `vscode.CancellationToken` / `AbortSignal` + transactional rollbacks on abort. | **Engineered** |
| 6 | **ELIGIBILITY & INTEGRATION** | TrueForge executes loop, VS Code uses HTTP/SDK, editor tools exposed as MCP, local TrueForge daemon, models configured in TrueForge. | Real `@truefoundry/trueforge-sdk` client, local Hono daemon on `8790`, Sentinel MCP server on `9099`, zero external provider keys in extension. | **Engineered** |
