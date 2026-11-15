import { TrueForge, TrueForgeError } from '@truefoundry/trueforge-sdk';
import { TrueForgeConnectionError } from '../shared/errors.js';

export interface TurnCallbacks {
  onTokenDelta?: (delta: string) => void;
  onToolCall?: (toolCall: { id: string; name: string; args: unknown }) => void;
  onToolApprovalRequired?: (toolCall: { id: string; name: string; args: unknown }) => Promise<boolean>;
  onToolResponse?: (response: { id: string; result: unknown }) => void;
  onTurnComplete?: (result: { turnId: string; status: string }) => void;
  onError?: (error: Error) => void;
}

export class TrueForgeHarnessClient {
  private client: TrueForge;

  constructor(
    private readonly baseUrl = 'http://localhost:8790',
    private readonly token = 'trueforge-standalone'
  ) {
    this.client = new TrueForge({
      baseUrl: this.baseUrl,
      token: this.token,
      timeoutInSeconds: 120,
      maxRetries: 2,
    });
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public async checkHealth(): Promise<{ status: string; version?: string }> {
    try {
      const resp = await fetch(`${this.baseUrl}/healthz`);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return (await resp.json()) as { status: string; version?: string };
    } catch (err) {
      throw new TrueForgeConnectionError(this.baseUrl, err);
    }
  }

  public async listConfiguredModels(): Promise<string[]> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/models`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!resp.ok) return [];
      const json = (await resp.json()) as { data?: Array<{ name: string; model_id: string; provider: string }> };
      return (json.data ?? []).map((m) => `${m.provider}/${m.model_id}`);
    } catch {
      return [];
    }
  }

  public async registerSentinelMcpServer(sseUrl: string): Promise<void> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/settings/mcp-servers/forge-sentinel-mcp`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          manifest: {
            type: 'remote',
            name: 'forge-sentinel-mcp',
            description: 'FORGE//SENTINEL VS Code Integration and Surgical Patch Staging Tools',
            url: sseUrl,
          },
        }),
      });

      if (!resp.ok && resp.status !== 409) {
        const body = await resp.text();
        console.warn(`Warning: Could not register MCP server in TrueForge (HTTP ${resp.status}): ${body}`);
      }
    } catch (err) {
      console.warn('Warning: TrueForge MCP server registration failed:', err);
    }
  }

  public async createSession(options?: {
    modelName?: string;
    instructions?: string;
    requireToolApproval?: boolean;
  }): Promise<string> {
    const configuredModels = await this.listConfiguredModels();
    const selectedModel = options?.modelName || (configuredModels.length > 0 ? configuredModels[0] : 'openai/gpt-4o');

    const instructions =
      options?.instructions ??
      `You are FORGE//SENTINEL, an expert repository-intelligent coding agent built for the TrueFoundry Forge-a-thon.
Core philosophy: "Understand First. Plan Intelligently. Change Precisely. Prove Everything."
You must inspect the codebase structure, search for relevant code, and propose surgical changes through the provided MCP tools.
Never make assumptions about file locations. Use search_workspace, find_symbol, and read_file to discover context.
When proposing changes, invoke propose_file_edit or propose_multi_file_edit. Explain the purpose, rationale, and impact for every changed file.
Execute tests via run_test_command to verify your work.`;

    const approvalRules = options?.requireToolApproval !== false
      ? ['propose_file_edit', 'propose_multi_file_edit', 'run_terminal_command']
      : [];

    try {
      const session = await this.client.sessions.create({
        agent: {
          spec: {
            model: { name: selectedModel },
            instructions,
            mcpServers: [
              {
                name: 'forge-sentinel-mcp',
                preload: true,
                enableTools: ['@all'],
                requireApprovalForTools: approvalRules,
              },
            ],
          },
        },
        metadata: {
          client: 'forge-sentinel-vscode',
          version: '1.0.0',
        },
      });

      return session.id;
    } catch (err: any) {
      if (err instanceof TrueForgeError) {
        throw new Error(`TrueForge Session Creation Failed [${err.statusCode}]: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }

  public async runTurn(
    sessionId: string,
    prompt: string,
    callbacks?: TurnCallbacks,
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      const stream = await this.client.sessions.createTurnStream(
        sessionId,
        {
          input: [{ type: 'user.message', content: prompt }],
        },
        { abortSignal }
      );

      let currentTurnId = '';

      for await (const event of stream) {
        switch (event.type) {
          case 'turn.created': {
            currentTurnId = event.id;
            break;
          }

          case 'model.message_delta': {
            if (event.delta && typeof event.delta === 'string') {
              callbacks?.onTokenDelta?.(event.delta);
            }
            break;
          }

          case 'tool.call': {
            callbacks?.onToolCall?.({
              id: (event as any).id ?? '',
              name: (event as any).name ?? '',
              args: (event as any).arguments ?? {},
            });
            break;
          }

          case 'tool.approval_required': {
            const toolCalls = (event as any).toolCalls ?? [];
            for (const call of toolCalls) {
              let approved = true;
              if (callbacks?.onToolApprovalRequired) {
                approved = await callbacks.onToolApprovalRequired(call);
              }

              if (currentTurnId) {
                await this.client.sessions.createTurnEvents(sessionId, currentTurnId, {
                  events: [
                    {
                      type: 'user.tool_approval',
                      threadId: (event as any).threadId,
                      toolCallId: call.id,
                      approval: { decision: approved ? 'approved' : 'rejected' },
                    },
                  ],
                });
              }
            }
            break;
          }

          case 'tool.response': {
            callbacks?.onToolResponse?.({
              id: (event as any).id ?? '',
              result: (event as any).response ?? {},
            });
            break;
          }

          case 'turn.done': {
            callbacks?.onTurnComplete?.({
              turnId: currentTurnId,
              status: (event as any).status ?? 'completed',
            });
            break;
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return;
      }
      callbacks?.onError?.(err);
      throw err;
    }
  }

  public async cancel(sessionId: string): Promise<void> {
    try {
      await this.client.sessions.cancel(sessionId);
    } catch (err) {
      console.warn(`Could not cancel session "${sessionId}":`, err);
    }
  }
}
