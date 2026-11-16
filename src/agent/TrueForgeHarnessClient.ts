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
      return (json.data ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  public async registerSentinelMcpServer(sseUrl: string): Promise<void> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/settings/mcp-servers`, {
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

  public async ensureNamedAgent(options?: {
    modelName?: string;
    instructions?: string;
    requireToolApproval?: boolean;
  }): Promise<string> {
    const configuredModels = await this.listConfiguredModels();
    const preferredModel =
      configuredModels.find((m) => m.includes('qwen-3-8-27b') || m.includes('qwen')) ||
      configuredModels.find((m) => m.includes('llama-3-1-8b') || m.includes('gpt-oss')) ||
      (configuredModels.length > 0 ? configuredModels[0] : 'groq/qwen-3-8-27b');
    const selectedModel = options?.modelName || preferredModel;

    const instructions =
      options?.instructions ??
      `You are FORGE//SENTINEL, an expert repository-intelligent coding agent built for the TrueFoundry Forge-a-thon.
Core philosophy: "Understand First. Plan Intelligently. Change Precisely. Prove Everything."
You must inspect the codebase structure, search for relevant code, and propose surgical changes through the provided MCP tools.
Never make assumptions about file locations. Use search_workspace, find_symbol, and read_file to discover context.
When proposing changes, invoke propose_file_edit or propose_multi_file_edit. Explain the purpose, rationale, and impact for every changed file.
Execute tests via run_test_command to verify your work.`;

    const approvalRules =
      options?.requireToolApproval !== false
        ? ['propose_file_edit', 'propose_multi_file_edit', 'run_terminal_command']
        : [];

    const agentName = 'forge-sentinel';
    const agentPayload = {
      name: agentName,
      description: 'FORGE//SENTINEL — Repository Intelligence & Engineering Agent',
      manifest: {
        model: { name: selectedModel },
        instructions,
        mcp_servers: [
          {
            name: 'forge-sentinel-mcp',
            preload: true,
            enable_tools: ['@all'],
            require_approval_for_tools: approvalRules,
          },
        ],
      },
    };

    const postResp = await fetch(`${this.baseUrl}/api/v1/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(agentPayload),
    });

    if (postResp.status === 409) {
      const listResp = await fetch(`${this.baseUrl}/api/v1/agents`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (listResp.ok) {
        const listJson = (await listResp.json()) as { data: Array<{ id: string; name: string }> };
        const match = listJson.data.find((a) => a.name === agentName);
        if (match) {
          const putResp = await fetch(`${this.baseUrl}/api/v1/agents/${match.id}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify({
              description: agentPayload.description,
              manifest: agentPayload.manifest,
            }),
          });
          if (!putResp.ok) {
            const errBody = await putResp.text();
            throw new Error(`Agent configuration rejected: ${errBody}`);
          }
        }
      }
    } else if (!postResp.ok) {
      const errBody = await postResp.text();
      throw new Error(`Agent creation rejected: ${errBody}`);
    }

    return agentName;
  }

  public async createSession(options?: {
    modelName?: string;
    instructions?: string;
    requireToolApproval?: boolean;
  }): Promise<string> {
    const agentName = await this.ensureNamedAgent(options);

    try {
      const sessionResponse = await this.client.sessions.create({
        agent: {
          name: agentName,
        },
        metadata: {
          client: 'forge-sentinel-vscode',
          version: '1.0.0',
        },
      });

      return sessionResponse.data.id;
    } catch (err: any) {
      if (err instanceof TrueForgeError) {
        throw new Error(`TrueForge Session Creation Failed [${err.statusCode}]: ${err.message}`, {
          cause: err,
        });
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
          assumeUser: 'session-creator',
          input: [{ type: 'user.message', content: prompt }],
        },
        { abortSignal }
      );

      let currentTurnId = '';

      for await (const event of stream) {
        switch (event.type) {
          case 'turn.created': {
            currentTurnId = (event as any).turnId ?? event.id;
            break;
          }

          case 'model.message.delta': {
            const rawCalls = (event as any).toolCalls ?? (event as any).tool_calls ?? [];
            for (const call of rawCalls) {
              const name = call.toolInfo?.name ?? call.function?.name ?? call.name ?? '';
              let args = call.function?.arguments ?? call.arguments ?? call.args ?? {};
              if (typeof args === 'string' && args.trim().length > 0) {
                try {
                  args = JSON.parse(args);
                } catch {
                  // partial json in streaming delta
                }
              }
              if (name) {
                callbacks?.onToolCall?.({
                  id: call.id ?? '',
                  name,
                  args,
                });
              }
            }

            const delta = (event as any).content ?? (event as any).delta;
            if (delta && typeof delta === 'string') {
              callbacks?.onTokenDelta?.(delta);
            }
            break;
          }

          case 'model.message': {
            const rawCalls = (event as any).tool_calls ?? (event as any).toolCalls ?? [];
            for (const call of rawCalls) {
              const name = call.function?.name ?? call.name ?? '';
              let args = call.function?.arguments ?? call.arguments ?? call.args ?? {};
              if (typeof args === 'string') {
                try {
                  args = JSON.parse(args);
                } catch {
                  // keep raw
                }
              }
              callbacks?.onToolCall?.({
                id: call.id ?? '',
                name,
                args,
              });
            }
            const directContent = (event as any).content ?? (event as any).text;
            if (directContent && typeof directContent === 'string' && rawCalls.length === 0) {
              callbacks?.onTokenDelta?.(directContent);
            }
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
                      approval: { status: approved ? 'allow' : 'deny' },
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
