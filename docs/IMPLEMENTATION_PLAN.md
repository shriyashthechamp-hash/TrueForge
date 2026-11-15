# FORGE//SENTINEL — IMPLEMENTATION PLAN & MILESTONES
## Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27

---

## Milestone Roadmap

```
+---------------------------------------------------------------------------------+
| M0: Environment & Reconnaissance                                                |
| [x] Verify Node 25+, Python 3.15+, pnpm, git                                    |
| [x] Clone TrueForge & Flask (pinned to 3.1.3 @ 22d92470)                        |
| [x] Isolate FORGE-SENTINEL standalone repo                                      |
| [x] Build TrueForge core and server, verify standalone HTTP on 8790             |
| [x] Author TRUEFORGE_RECONNAISSANCE.md & VSCODE_API_RECONNAISSANCE.md           |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| M1: Architecture & Specifications                                               |
| [x] ARCHITECTURE.md, IMPLEMENTATION_PLAN.md                                     |
| [x] SECURITY_MODEL.md, TEST_STRATEGY.md                                         |
| [x] COMPETITION_SCORECARD.md, DECISIONS.md                                      |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| M2: Core Engine & MCP Server Architecture                                       |
| [ ] Scaffold FORGE-SENTINEL TypeScript package (package.json, tsconfig, vitest) |
| [ ] Implement Sentinel MCP Server (`@modelcontextprotocol/sdk`)                 |
| [ ] Implement Workspace Read Tools (read, search, list, symbol)                 |
| [ ] Implement Staged Patch Engine (unified diff parser, hunk model)             |
| [ ] Implement Propose Edit Tools (propose_file_edit, propose_multi_file_edit)     |
| [ ] Implement Terminal Execution Tool with safety sandboxing                    |
| [ ] Unit tests for MCP tools and patch generation                               |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| M3: TrueForge Integration Client & Agent Definition                             |
| [ ] Build TrueForge client using `@truefoundry/trueforge-sdk`                   |
| [ ] Implement AgentSpec definition with registered Sentinel MCP tools           |
| [ ] Implement SSE Turn Streaming consumer                                       |
| [ ] Implement Tool Approval & Response dispatch handlers                        |
| [ ] Integration test: Real session creation and turn lifecycle                 |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| M4: Repository Intelligence (CODEBASE MRI & CONTEXT AUCTION)                    |
| [ ] Implement Codebase MRI (AST symbol extractor, file graph, test mapping)     |
| [ ] Implement Context Auction scoring engine (lexical, symbols, imports, tests) |
| [ ] Support explicit @file and @symbol mentions                                 |
| [ ] Generate structured Context Selection Receipt JSON                          |
| [ ] Tests for MRI indexing and Auction budget allocations                       |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| M5: VS Code Extension Frontend & Interactive UX                                 |
| [ ] Scaffold VS Code Extension manifests (`package.json`, views, commands)      |
| [ ] Implement Sentinel Sidebar Webview (Command Center, streaming chat, receipt)|
| [ ] Implement Inline Edit Controller (`Cmd+Shift+K`, active editor capture)     |
| [ ] Implement Native Diff Review (`vscode.diff`, hunk accept/reject)            |
| [ ] Implement Transactional Apply & Revert via `vscode.WorkspaceEdit`           |
| [ ] Implement Agent Flight Recorder tree view & Proof of Change report          |
+---------------------------------------------------------------------------------+
                                      |
                                      v
+---------------------------------------------------------------------------------+
| M6: Competition Tasks Verification & Resilience Proof                           |
| [ ] Task A: Inline Edit on Flask `helpers.py` (`get_debug_flag`)                |
| [ ] Task B: Multi-File Agent Mode on Flask (CLI command `flask config`)         |
| [ ] Task C: Resilience Test (Graceful fallback on connection/auth failure)      |
| [ ] Verify test suite passes on Flask test target                               |
+---------------------------------------------------------------------------------+
```
