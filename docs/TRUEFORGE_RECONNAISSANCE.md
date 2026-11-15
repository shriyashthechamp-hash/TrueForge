# TRUEFORGE TECHNICAL RECONNAISSANCE REPORT
## Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27
### FORGE//SENTINEL Core Runtime Integration Reference

---

## 1. TrueForge Architecture Overview

TrueForge is an open-source agent harness designed to decouple the agent execution loop, sandboxing, tool dispatch, approvals, session persistence, and streaming from client interfaces.

Based on inspection of `trueforge/` source tree (`packages/trueforge`, `packages/trueforge-core`, `packages/trueforge-sdk`):

- **Server Core (`packages/trueforge`)**: Built on Hono (`hono` + `@hono/node-server` + `@hono/zod-openapi`) providing an OpenAPI-compliant HTTP and SSE runtime.
- **Topologies (`src/config.ts`)**:
  - **Standalone Mode (`STANDALONE=true`, default)**: Single-process, SQLite persistence (`better-sqlite3`), in-process turn execution. Default port: `8790`. Default local API key: `trueforge-standalone`.
  - **Hosted Mode (`STANDALONE=false`)**: Multi-replica architecture with PostgreSQL (via `kysely`) and Redis pub/sub for executor peering and cross-replica SSE fan-out.
- **Client SDK (`@truefoundry/trueforge-sdk`)**: Fern-generated, typed TypeScript library providing synchronous operations and SSE async-iterable streams (`core.Stream<TrueForge.TurnStreamingEvent>`).
- **MCP Subsystem**: Native Model Context Protocol (MCP) support via `@modelcontextprotocol/sdk` (^1.32.0), supporting remote MCP servers, header/OAuth authentication, deferred tool resolution, and per-tool human approval gates.

---

## 2. Session Lifecycle & Creation

Sessions represent isolated, persistent conversation and state threads.

- **API Route**: `POST /api/v1/sessions` (`packages/trueforge/src/routes/sessionRoutes.ts`)
- **SDK Method**: `client.sessions.create(request: TrueForge.CreateSessionRequest)`
- **Session Types**:
  1. **Named Agent Session**: Bound to a registered named agent definition:
     ```typescript
     await client.sessions.create({
       agent: { name: "forge-sentinel" },
       metadata: { project: "flask-evaluation" }
     });
     ```
  2. **Inline Agent Spec Session**: Instantiated directly with an explicit `AgentSpec`:
     ```typescript
     await client.sessions.create({
       agent: {
         spec: {
           model: { name: "openai/gpt-5.2" },
           instructions: "You are FORGE//SENTINEL, an expert repository-intelligent coding agent...",
           mcpServers: [{
             name: "forge-sentinel-tools",
             enableTools: ["@all"],
             requireApprovalForTools: ["@write", "@destructive"]
           }]
         }
       }
     });
     ```

---

## 3. Agent Turns & Execution Loop

Agent turns execute one interaction cycle (prompt -> model invocation -> tool calls -> tool results -> final model response).

- **API Route**: `POST /api/v1/sessions/{session_id}/turns`
- **SDK Method**: `client.sessions.createTurnStream(session_id, request, requestOptions)`
- **Request Payload (`CreateTurnSessionsStreamRequest`)**:
  ```typescript
  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [
      {
        type: "user.message",
        content: "Add a new built-in CLI command flask config..."
      }
    ]
  });
  ```
- **Execution Guarantee**: TrueForge manages the LLM call loop, tool resolution, and subagent orchestration entirely inside the harness. VS Code acts as an MCP server provider and UI controller, never running an independent model loop.

---

## 4. Streaming Event Consumption

The streaming response uses Server-Sent Events (SSE) parsed into typed `TurnStreamingEvent` objects.

```typescript
for await (const event of stream) {
  switch (event.type) {
    case "turn.created":
      // Turn initialized (monotonic ULID, turn ID)
      break;
    case "model.message":
    case "model.message_delta":
      // Text stream chunk from model
      break;
    case "tool.call":
      // Model requests tool execution
      break;
    case "tool.approval_required":
      // Execution paused waiting for human approval
      break;
    case "tool.response_required":
      // Client-side tool execution requested
      break;
    case "tool.response":
      // Tool execution completed and reported to harness
      break;
    case "turn.done":
      // Turn terminal status (completed, failed, cancelled)
      break;
  }
}
```

---

## 5. Tool Calls, Approvals, & Client Responses

TrueForge has built-in human-in-the-loop approval workflows:

1. **Approval Detection**:
   When an agent calls a tool marked in `requireApprovalForTools` (e.g. `propose_file_edit`, `run_terminal_command`), the server pauses turn execution and emits `tool.approval_required`:
   ```typescript
   interface ToolApprovalRequiredEvent {
     type: "tool.approval_required";
     id: string;
     threadId: string;
     toolCalls: ToolCallRef[];
   }
   ```
2. **Posting User Approval**:
   Using `client.sessions.createTurnEvents(sessionId, turnId, { events: [...] })`:
   ```typescript
   await client.sessions.createTurnEvents(sessionId, turnId, {
     events: [
       {
         type: "user.tool_approval",
         threadId: event.threadId,
         toolCallId: toolCall.id,
         approval: { decision: "approved" } // or "rejected"
       }
     ]
   });
   ```
3. **Client-Side Tool Handling (`tool.response_required`)**:
   For client-side/editor tools, the client submits the output back via `user.tool_response`:
   ```typescript
   await client.sessions.createTurnEvents(sessionId, turnId, {
     events: [
       {
         type: "user.tool_response",
         threadId: event.threadId,
         toolCallId: toolCall.id,
         content: JSON.stringify(toolResult)
       }
     ]
   });
   ```

---

## 6. MCP Server & Tool Registration

TrueForge connects to MCP servers over HTTP/SSE.

- **Registration API**: `client.settings.mcpServers.create` or `createOrUpdate`
- **Route**: `POST /api/v1/settings/mcp-servers`
- **Configuration Manifest (`RemoteMcpServerManifest`)**:
  ```typescript
  await client.settings.mcpServers.createOrUpdate("forge-sentinel-mcp", {
    manifest: {
      type: "remote",
      name: "forge-sentinel-mcp",
      description: "FORGE//SENTINEL VS Code Editor Intelligence and Patch Execution Server",
      url: "http://localhost:9099/sse"
    }
  });
  ```
- **Agent Binding**:
  In `AgentSpec`:
  ```typescript
  mcpServers: [
    {
      name: "forge-sentinel-mcp",
      preload: true, // upfront schema discovery
      enableTools: ["@all"],
      requireApprovalForTools: ["@write", "@destructive", "propose_file_edit", "run_terminal_command"]
    }
  ]
  ```

---

## 7. Context Engineering & Capabilities

TrueForge includes native context engineering primitives:
- **Compaction**: Native thread compaction (`thread.context_compaction_started`, `thread.context_compaction_finished`) when context approaches model token limits.
- **Subagents**: Ability to invoke sub-agents for parallel research or verification without polluting primary session memory.
- **Deferred Tool Loading**: When `preload: false`, tool definitions are lazily loaded on demand via tool search, keeping system prompts compact.
- **Code Mode**: Direct code execution for data processing tasks without raw string roundtrips.

---

## 8. Cancellation & Transactional Safety

- **Cancellation Endpoint**: `POST /api/v1/sessions/{session_id}/cancel`
- **SDK Method**: `client.sessions.cancel(sessionId)`
- **Behavior**: Accepts cancellation immediately, marks active turns as aborted, halts further model generation and tool execution.
- **Stream Abort**: The SDK accepts standard `AbortSignal` via `requestOptions.abortSignal`, severing the SSE connection instantly without hanging.

---

## 9. Starting Local TrueForge

Standalone mode runs without Docker, Postgres, or Redis:
```bash
# Production CLI entry
npx @truefoundry/trueforge --port 8790

# From source checkout
cd trueforge
pnpm --filter @truefoundry/trueforge build
STANDALONE=true PORT=8790 node packages/trueforge/dist/cli.js
```

Default credentials in standalone mode:
- URL: `http://localhost:8790`
- API Key: `trueforge-standalone` (or via `TRUEFORGE_API_KEY` environment variable)

---

## 10. SDK Usage Reference (Verified Against Source)

```typescript
import { TrueForge, TrueForgeError } from "@truefoundry/trueforge-sdk";

export class TrueForgeHarnessClient {
  private client: TrueForge;

  constructor(baseUrl = "http://localhost:8790", token = "trueforge-standalone") {
    this.client = new TrueForge({
      baseUrl,
      token,
      timeoutInSeconds: 120,
      maxRetries: 2
    });
  }

  async createSession(spec: TrueForge.AgentSpec) {
    return await this.client.sessions.create({
      agent: { spec }
    });
  }

  async runTurn(sessionId: string, prompt: string, abortSignal?: AbortSignal) {
    return await this.client.sessions.createTurnStream(
      sessionId,
      {
        input: [{ type: "user.message", content: prompt }]
      },
      { abortSignal }
    );
  }

  async cancel(sessionId: string) {
    return await this.client.sessions.cancel(sessionId);
  }
}
```

---

## 11. Architectural Directives for FORGE//SENTINEL

1. **Zero External LLM Calls**: All intelligence flows strictly through TrueForge. The VS Code extension does not contain OpenAI, Anthropic, or Gemini SDKs.
2. **Dedicated MCP Bridge**: FORGE//SENTINEL runs a local MCP server that exposes the workspace file inspection, indexing, patch staging, and terminal execution tools to TrueForge.
3. **Safety-First Patches**: Changes proposed by the agent are staged in memory/disk as diff hunks. They are NEVER written silently. They require explicit developer hunk-by-hunk review via native VS Code diff views.
4. **Resilient Session State**: If TrueForge disconnects or reports an error, the extension catches `TrueForgeError`, reports actionable diagnostics, and maintains workspace immutability.
