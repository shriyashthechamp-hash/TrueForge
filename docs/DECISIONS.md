# FORGE//SENTINEL — ARCHITECTURAL DECISION RECORDS (ADR)
## Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27

---

### ADR 001: Separation of TrueForge Harness and Extension Workspace
- **Context**: The competition requires TrueForge to drive the autonomous loop while preserving repository hygiene.
- **Decision**: Keep `trueforge/` and `flask/` as sibling clones outside the submission repository `FORGE-SENTINEL/`. `FORGE-SENTINEL/` is an independent, self-contained TypeScript repository.
- **Consequences**: Zero risk of polluting upstream git histories; clean, reproducible submission repo.

### ADR 002: Dual-Process Architecture (VS Code Extension + MCP Server)
- **Context**: TrueForge connects to MCP servers over remote HTTP/SSE transports.
- **Decision**: The extension starts an embedded lightweight HTTP/SSE MCP server (on an ephemeral or configured port, default `9099`) implementing the Model Context Protocol. TrueForge registers this server as `type: "remote"` via `client.settings.mcpServers.createOrUpdate`.
- **Consequences**: Completely aligns with TrueForge's official remote MCP server paradigm. TrueForge calls tools over standard SSE; the extension executes them with active workspace context.

### ADR 003: Staged Patches Instead of Direct Workspace Mutation
- **Context**: AI agents modifying workspaces directly can corrupt user files or introduce silent errors.
- **Decision**: All modification tools (`propose_file_edit`, `propose_multi_file_edit`) only stage patches into memory with unified diff hunks. Modification of the actual filesystem occurs only upon explicit developer approval through `vscode.WorkspaceEdit`.
- **Consequences**: Total human-in-the-loop safety, non-destructive rollbacks, and native undo (`Cmd+Z`).

### ADR 004: Multi-Dimensional Context Auction
- **Context**: Raw semantic embedding of an entire repository can exceed token budgets and include noisy, irrelevant context.
- **Decision**: Context Auction scores candidate snippets using a weighted blend of explicit mentions (`@file`, `@symbol`), symbol call-graph proximity, lexical match, and test affinity, generating a verifiable Context Selection Receipt.
- **Consequences**: Precise, verifiable context fitting within strict token limits without relying on heavy external vector databases.
