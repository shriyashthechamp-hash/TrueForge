import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrueForge, TrueForgeError } from '@truefoundry/trueforge-sdk';
import { TrueForgeConnectionError } from '../shared/errors.js';

export interface TrueForgeModelInfo {
  name: string;
  modelId: string;
  displayName: string;
  provider: string;
  contextLength: number;
  maxOutputTokens: number;
  isAvailable: boolean;
  isPreferred: boolean;
}

export interface TurnCallbacks {
  onTokenDelta?: (delta: string) => void;
  onToolCall?: (toolCall: { id: string; name: string; args: unknown }) => void;
  onToolApprovalRequired?: (toolCall: { id: string; name: string; args: unknown }) => Promise<boolean>;
  onToolResponse?: (response: { id: string; result: unknown }) => void;
  onTurnComplete?: (result: {
    turnId: string;
    status: string;
    error?: string;
    tokensReceived?: number;
  }) => void;
  onError?: (error: Error) => void;
}

export class TrueForgeHarnessClient {
  private client: TrueForge;
  private geminiAutoSyncAttempted = false;
  private openrouterAutoSyncAttempted = false;
  private sessionInstructions = new Map<string, string | undefined>();
  private static quotaExhaustedModels = new Set<string>();

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

  /**
   * Resolves GEMINI_API_KEY from process.env or local gitignored .env files without logging secrets.
   */
  public resolveGeminiApiKeyFromEnvironment(workspaceRoot?: string): string | undefined {
    const fromEnv = process.env.GEMINI_API_KEY?.trim();
    if (fromEnv && fromEnv !== 'your_gemini_api_key_here') {
      return fromEnv;
    }

    const candidateDirs = [
      workspaceRoot,
      process.cwd(),
      path.resolve(process.cwd(), 'FORGE-SENTINEL'),
      path.resolve(process.cwd(), '..'),
      path.resolve(process.cwd(), '..', 'FORGE-SENTINEL'),
    ].filter((d): d is string => Boolean(d));

    for (const dir of candidateDirs) {
      for (const fileName of ['.env', '.env.local']) {
        const envPath = path.join(dir, fileName);
        try {
          if (fs.existsSync(envPath)) {
            const raw = fs.readFileSync(envPath, 'utf8');
            for (const line of raw.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const match = trimmed.match(/^GEMINI_API_KEY\s*=\s*(.+)$/);
              if (match) {
                const val = match[1].trim().replace(/^['"]|['"]$/g, '');
                if (val && val !== 'your_gemini_api_key_here') {
                  return val;
                }
              }
            }
          }
        } catch {
          // ignore unreadable .env files
        }
      }
    }

    return undefined;
  }

  /**
   * Resolves OPENROUTER_API_KEY from process.env or local gitignored .env files without logging secrets.
   */
  public resolveOpenRouterApiKeyFromEnvironment(workspaceRoot?: string): string | undefined {
    const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
    if (fromEnv && fromEnv !== 'your_openrouter_api_key_here') {
      return fromEnv;
    }

    const candidateDirs = [
      workspaceRoot,
      process.cwd(),
      path.resolve(process.cwd(), 'FORGE-SENTINEL'),
      path.resolve(process.cwd(), '..'),
      path.resolve(process.cwd(), '..', 'FORGE-SENTINEL'),
    ].filter((d): d is string => Boolean(d));

    for (const dir of candidateDirs) {
      for (const fileName of ['.env', '.env.local']) {
        const envPath = path.join(dir, fileName);
        try {
          if (fs.existsSync(envPath)) {
            const raw = fs.readFileSync(envPath, 'utf8');
            for (const line of raw.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const match = trimmed.match(/^OPENROUTER_API_KEY\s*=\s*(.+)$/);
              if (match) {
                const val = match[1].trim().replace(/^['"]|['"]$/g, '');
                if (val && val !== 'your_openrouter_api_key_here') {
                  return val;
                }
              }
            }
          }
        } catch {
          // ignore unreadable .env files
        }
      }
    }

    return undefined;
  }

  /**
   * Registers or updates OpenRouter in TrueForge's centralized model provider store
   * when OPENROUTER_API_KEY is available in the environment or .env.
   */
  public async ensureOpenRouterProviderConfigured(apiKey?: string, workspaceRoot?: string): Promise<boolean> {
    const key = apiKey ?? this.resolveOpenRouterApiKeyFromEnvironment(workspaceRoot);
    if (!key) {
      return false;
    }

    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/settings/model-providers`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          manifest: {
            type: 'custom',
            name: 'openrouter',
            base_url: 'https://openrouter.ai/api/v1',
            auth: {
              api_key: key,
            },
            models: [
              {
                model_id: 'google/gemini-2.5-flash',
                name: 'gemini-2-5-flash',
                properties: {
                  context_length: 1048576,
                  max_output_tokens: 4096,
                },
              },
              {
                model_id: 'meta-llama/llama-3.3-70b-instruct',
                name: 'llama-3-3-70b-instruct',
                properties: {
                  context_length: 131072,
                  max_output_tokens: 4096,
                },
              },
              {
                model_id: 'deepseek/deepseek-chat',
                name: 'deepseek-chat',
                properties: {
                  context_length: 163840,
                  max_output_tokens: 4096,
                },
              },
            ],
          },
        }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
  public async ensureGeminiProviderConfigured(apiKey?: string, workspaceRoot?: string): Promise<boolean> {
    const key = apiKey ?? this.resolveGeminiApiKeyFromEnvironment(workspaceRoot);
    if (!key) {
      return false;
    }

    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/settings/model-providers`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          manifest: {
            type: 'google-gemini',
            auth: {
              api_key: key,
            },
            models: [
              {
                model_id: 'gemini-3.8-flash',
                name: 'gemini-3-8-flash',
                properties: {
                  context_length: 1048576,
                  max_output_tokens: 65536,
                  reasoning_efforts: ['low', 'medium', 'high'],
                },
              },
              {
                model_id: 'gemini-flash-lite-latest',
                name: 'gemini-flash-lite-latest',
                properties: {
                  context_length: 1048576,
                  max_output_tokens: 65536,
                },
              },
              {
                model_id: 'gemini-3.5-flash',
                name: 'gemini-3-5-flash',
                properties: {
                  context_length: 1048576,
                  max_output_tokens: 65536,
                },
              },
              {
                model_id: 'gemini-2.5-flash',
                name: 'gemini-2-5-flash',
                properties: {
                  context_length: 1048576,
                  max_output_tokens: 65536,
                },
              },
            ],
          },
        }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  public formatModelDisplayName(name: string, modelId?: string): string {
    const raw = (modelId || name).toLowerCase();
    const lowerName = name.toLowerCase();

    if (raw.includes('gemini-3.8-flash') || lowerName.includes('gemini-3-8-flash')) {
      return 'Gemini 3.8 Flash (Google)';
    }
    if (raw.includes('gemini-flash-lite') || lowerName.includes('gemini-flash-lite')) {
      return 'Gemini Flash Lite (Google)';
    }
    if (raw.includes('gemini-3.7-flash') || lowerName.includes('gemini-3-7-flash')) {
      return 'Gemini 3.7 Flash (Google)';
    }
    if (raw.includes('gemini-3.6-flash') || lowerName.includes('gemini-3-6-flash')) {
      return 'Gemini 3.6 Flash (Google)';
    }
    if (raw.includes('gemini-3.5-flash') || lowerName.includes('gemini-3-5-flash')) {
      return 'Gemini 3.5 Flash (Google)';
    }
    if (raw.includes('gemini') || lowerName.startsWith('google-gemini/') || lowerName.startsWith('google/')) {
      const cleanGemini = (modelId || name)
        .replace(/^google-gemini\//i, '')
        .replace(/^google\//i, '');
      return `${cleanGemini} (Google)`;
    }
    if (raw.includes('qwen3.8-27b') || lowerName.includes('qwen-3-8-27b')) {
      return 'Qwen 3.8 27B (Groq)';
    }
    if (raw.includes('llama-3.1-8b-instant') || lowerName.includes('llama-3-1-8b')) {
      return 'Llama 3.1 8B Instant (Groq)';
    }
    if (raw.includes('gpt-oss-120b') || lowerName.includes('gpt-oss-120b')) {
      return 'GPT-OSS 120B (Groq)';
    }
    if (raw.includes('gpt-oss-20b') || lowerName.includes('gpt-oss-20b')) {
      return 'GPT-OSS 20B (Groq)';
    }
    if (raw.includes('llama-3.3-70b') || raw.includes('llama-3.1-8b')) {
      if (lowerName.startsWith('openrouter/')) {
        return 'Llama 3.3 70B (OpenRouter)';
      }
      return `${modelId || name} (Unavailable)`;
    }
    if (lowerName.startsWith('openrouter/')) {
      const modelPart = (modelId || name.replace(/^openrouter\//, ''));
      if (modelPart.includes('llama-3.3-70b') || modelPart.includes('llama-3-3-70b')) {
        return 'Llama 3.3 70B (OpenRouter)';
      }
      if (modelPart.includes('gemini-2.5-flash') || modelPart.includes('gemini-2-5-flash')) {
        return 'Gemini 2.5 Flash (OpenRouter)';
      }
      if (modelPart.includes('deepseek-chat') || modelPart.includes('deepseek')) {
        return 'DeepSeek V3 (OpenRouter)';
      }
      return `${modelPart} (OpenRouter)`;
    }
    const clean = name
      .replace(/^google-gemini\//, '')
      .replace(/^google\//, '')
      .replace(/^groq\//, '')
      .replace(/^openai\//, '');
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }

  public async getAvailableModels(): Promise<TrueForgeModelInfo[]> {
    try {
      let resp = await fetch(`${this.baseUrl}/api/v1/models`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!resp.ok) return [];
      let json = (await resp.json()) as {
        data?: Array<{
          name: string;
          model_id: string;
          provider?: { name: string };
          properties?: { context_length?: number; max_output_tokens?: number };
        }>;
      };

      let raw = json.data ?? [];
      const hasGemini = raw.some(
        (m) => m.model_id === 'gemini-3.8-flash' || m.name.includes('gemini-3-8-flash') || m.name.includes('gemini-3.8-flash')
      );

      if (!hasGemini && !this.geminiAutoSyncAttempted) {
        this.geminiAutoSyncAttempted = true;
        const synced = await this.ensureGeminiProviderConfigured();
        if (synced) {
          resp = await fetch(`${this.baseUrl}/api/v1/models`, {
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (resp.ok) {
            json = (await resp.json()) as typeof json;
            raw = json.data ?? [];
          }
        }
      }

      const hasOpenRouter = raw.some((m) => m.name.startsWith('openrouter/'));
      if (!hasOpenRouter && !this.openrouterAutoSyncAttempted) {
        this.openrouterAutoSyncAttempted = true;
        const syncedOr = await this.ensureOpenRouterProviderConfigured();
        if (syncedOr) {
          resp = await fetch(`${this.baseUrl}/api/v1/models`, {
            headers: { Authorization: `Bearer ${this.token}` },
          });
          if (resp.ok) {
            json = (await resp.json()) as typeof json;
            raw = json.data ?? [];
          }
        }
      }

      return raw.map((m) => {
        // Disallow deprecated/unavailable models that return 404
        const isUnavailable =
          m.name.includes('llama-3-3-70b-versatile') ||
          m.model_id.includes('llama-3.3-70b-versatile') ||
          m.name.includes('llama-3-1-8b-instant') ||
          m.model_id.includes('llama-3.1-8b-instant');

        const isGemini38 =
          m.model_id === 'gemini-3.8-flash' ||
          m.name.includes('gemini-3-8-flash') ||
          m.name.includes('gemini-3.8-flash');

        const rawProvider = m.provider?.name ?? m.name.split('/')[0] ?? 'google';
        const normalizedProvider = rawProvider === 'google-gemini' ? 'google' : rawProvider;

        return {
          name: m.name,
          modelId: m.model_id,
          displayName: this.formatModelDisplayName(m.name, m.model_id),
          provider: normalizedProvider,
          contextLength: m.properties?.context_length ?? (isGemini38 ? 1048576 : 131072),
          maxOutputTokens: m.properties?.max_output_tokens ?? (isGemini38 ? 65536 : 8192),
          isAvailable: !isUnavailable,
          isPreferred: isGemini38,
        };
      });
    } catch {
      return [];
    }
  }

  public async resolveAuthoritativeModel(preferredName?: string): Promise<TrueForgeModelInfo> {
    const models = await this.getAvailableModels();

    if (preferredName) {
      const direct = models.find(
        (m) => (m.name === preferredName || m.modelId === preferredName) && m.isAvailable
      );
      if (direct) return direct;
    }

    // 1. Highest priority: Native Google Gemini 3.8 Flash (google-gemini/gemini-3-8-flash)
    const nativeGemini38 = models.find(
      (m) =>
        m.name.startsWith('google-gemini/') &&
        (m.modelId === 'gemini-3.8-flash' ||
          m.name.includes('gemini-3-8-flash') ||
          m.name.includes('gemini-3.8-flash')) &&
        m.isAvailable
    );
    if (nativeGemini38) return nativeGemini38;

    // 2. Next: Primary Google Gemini 3.8 Flash from any registered provider
    const gemini38 = models.find(
      (m) =>
        (m.modelId === 'gemini-3.8-flash' ||
          m.name.includes('gemini-3-8-flash') ||
          m.name.includes('gemini-3.8-flash')) &&
        m.isAvailable
    );
    if (gemini38) return gemini38;

    // 3. Any other native Google Gemini model (e.g. google-gemini/gemini-flash-lite-latest)
    const nativeGemini = models.find(
      (m) => m.name.startsWith('google-gemini/') && m.isAvailable
    );
    if (nativeGemini) return nativeGemini;

    // 4. Any other preferred or available Google Gemini model
    const anyGemini = models.find(
      (m) => (m.provider.toLowerCase().includes('google') || m.name.includes('gemini')) && m.isAvailable
    );
    if (anyGemini) return anyGemini;

    // 5. Any explicitly marked preferred available model (BYO-model compatibility)
    const preferred = models.find((m) => m.isPreferred && m.isAvailable);
    if (preferred) return preferred;

    // 6. Next priority: Any non-blacklisted available model (only if no Gemini model is registered)
    const anyUsable = models.find((m) => m.isAvailable && !m.name.startsWith('groq/'));
    if (anyUsable) return anyUsable;

    // Authoritative primary fallback: Google Gemini 3.8 Flash
    return {
      name: 'google-gemini/gemini-3-8-flash',
      modelId: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash (Google)',
      provider: 'google',
      contextLength: 1048576,
      maxOutputTokens: 65536,
      isAvailable: true,
      isPreferred: true,
    };
  }

  public async listConfiguredModels(): Promise<string[]> {
    const models = await this.getAvailableModels();
    return models.filter((m) => m.isAvailable).map((m) => m.name);
  }

  public async registerSentinelMcpServer(sseUrl: string): Promise<boolean> {
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
      throw new Error(`Could not register MCP server in TrueForge (HTTP ${resp.status}): ${body}`);
    }
    return true;
  }

  public async getRegisteredMcpServer(name = 'forge-sentinel-mcp'): Promise<{ name: string; url: string; type: string } | null> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/settings/mcp-servers/${name}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });
      if (resp.status === 404) return null;
      if (!resp.ok) return null;
      const data: any = await resp.json();
      const manifest = data?.manifest ?? data;
      return {
        name: manifest.name ?? name,
        url: manifest.url ?? '',
        type: manifest.type ?? 'remote',
      };
    } catch {
      return null;
    }
  }

  public async ensureMcpServerSynchronized(sseUrl: string): Promise<{ synchronized: boolean; registeredUrl?: string }> {
    const existing = await this.getRegisteredMcpServer('forge-sentinel-mcp');
    if (existing && existing.url === sseUrl) {
      return { synchronized: true, registeredUrl: existing.url };
    }
    await this.registerSentinelMcpServer(sseUrl);
    return { synchronized: true, registeredUrl: sseUrl };
  }

  public async checkMcpServerHealth(mcpHealthUrl = 'http://localhost:9099/healthz'): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);
      const resp = await fetch(mcpHealthUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) return false;
      const data: any = await resp.json().catch(() => ({}));
      return data?.status === 'ok' && data?.server === 'forge-sentinel-mcp';
    } catch {
      return false;
    }
  }

  public resolveFallbackModel(): string {
    // Prefer native google-gemini models for full thought-signature support during tool replays
    if (!TrueForgeHarnessClient.quotaExhaustedModels.has('gemini-flash-lite-latest')) {
      return 'google-gemini/gemini-flash-lite-latest';
    }
    if (!TrueForgeHarnessClient.quotaExhaustedModels.has('gemini-3.5-flash')) {
      return 'google-gemini/gemini-3-5-flash';
    }
    if (!TrueForgeHarnessClient.quotaExhaustedModels.has('gemini-2.5-flash')) {
      return 'google-gemini/gemini-2-5-flash';
    }
    // Fallback: OpenRouter verified tool-calling models
    if (!TrueForgeHarnessClient.quotaExhaustedModels.has('openrouter/gemini-2-5-flash')) {
      return 'openrouter/gemini-2-5-flash';
    }
    if (!TrueForgeHarnessClient.quotaExhaustedModels.has('openrouter/llama-3-3-70b-instruct')) {
      return 'openrouter/llama-3-3-70b-instruct';
    }
    return 'google-gemini/gemini-flash-lite-latest';
  }

  public async ensureNamedAgent(options?: {
    modelName?: string;
    instructions?: string;
    requireToolApproval?: boolean;
  }): Promise<string> {
    let selectedModel = options?.modelName;
    if (
      !selectedModel ||
      TrueForgeHarnessClient.quotaExhaustedModels.has(selectedModel) ||
      TrueForgeHarnessClient.quotaExhaustedModels.has(selectedModel.toLowerCase()) ||
      ((selectedModel.includes('gemini-3-8-flash') || selectedModel.includes('gemini-3.8-flash')) &&
        (TrueForgeHarnessClient.quotaExhaustedModels.has('gemini-3.8-flash') ||
          TrueForgeHarnessClient.quotaExhaustedModels.has('google/gemini-3-8-flash') ||
          TrueForgeHarnessClient.quotaExhaustedModels.has('google-gemini/gemini-3-8-flash'))) ||
      ((selectedModel.includes('gemini-2-5-flash') || selectedModel.includes('gemini-2.5-flash')) &&
        (TrueForgeHarnessClient.quotaExhaustedModels.has('gemini-2.5-flash') ||
          TrueForgeHarnessClient.quotaExhaustedModels.has('google/gemini-2-5-flash') ||
          TrueForgeHarnessClient.quotaExhaustedModels.has('google-gemini/gemini-2-5-flash')))
    ) {
      selectedModel = this.resolveFallbackModel();
    } else if (!selectedModel) {
      const authoritative = await this.resolveAuthoritativeModel();
      selectedModel = authoritative.name;
    }

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

      const id = sessionResponse.data.id;
      this.sessionInstructions.set(id, options?.instructions);
      return id;
    } catch (err: any) {
      if (err instanceof TrueForgeError) {
        throw new Error(`TrueForge Session Creation Failed [${err.statusCode}]: ${err.message}`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  public isFallbackEligible(errorText: string): boolean {
    const lower = errorText.toLowerCase();
    return (
      lower.includes('429') ||
      lower.includes('too many requests') ||
      lower.includes('rate limit') ||
      lower.includes('model error') ||
      lower.includes('resource_exhausted') ||
      lower.includes('quota exceeded') ||
      lower.includes('free_tier') ||
      lower.includes('generate_content_free_tier_requests') ||
      lower.includes('exceeded your current quota') ||
      lower.includes('503') ||
      lower.includes('502') ||
      lower.includes('504') ||
      lower.includes('high demand') ||
      lower.includes('spikes in demand') ||
      lower.includes('service unavailable') ||
      lower.includes('headers timeout') ||
      lower.includes('overloaded')
    );
  }

  public async runTurn(
    sessionId: string,
    prompt: string,
    callbacks?: TurnCallbacks,
    abortSignal?: AbortSignal,
    allowFallback: boolean | number = true
  ): Promise<void> {
    const remainingRetries = typeof allowFallback === 'number' ? allowFallback : (allowFallback ? 3 : 0);
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
      let receivedTokensCount = 0;
      let lastErrorMessage = '';
      const streamingToolCalls = new Map<string, { id: string; name: string; rawArgs: string }>();
      const emittedToolCallIds = new Set<string>();

      for await (const event of stream) {
        switch (event.type as string) {
          case 'turn.created': {
            currentTurnId = (event as any).turnId ?? event.id;
            break;
          }

          case 'model.message.delta': {
            const rawCalls = (event as any).toolCalls ?? (event as any).tool_calls ?? [];
            for (const call of rawCalls) {
              const callId = call.id ?? `idx_${call.index ?? 0}`;
              const name = call.toolInfo?.name ?? call.function?.name ?? call.name ?? '';
              const argChunk = call.function?.arguments ?? call.arguments ?? call.args;

              const existing = streamingToolCalls.get(callId) ?? { id: callId, name: '', rawArgs: '' };
              if (name) existing.name = name;
              if (typeof argChunk === 'string') {
                existing.rawArgs += argChunk;
              } else if (argChunk && typeof argChunk === 'object') {
                existing.rawArgs = JSON.stringify(argChunk);
              }
              streamingToolCalls.set(callId, existing);

              if (existing.name && !emittedToolCallIds.has(callId)) {
                let parsedArgs: unknown = {};
                if (existing.rawArgs.trim().length > 0) {
                  try {
                    parsedArgs = JSON.parse(existing.rawArgs);
                    emittedToolCallIds.add(callId);
                    callbacks?.onToolCall?.({
                      id: call.id ?? callId,
                      name: existing.name,
                      args: parsedArgs,
                    });
                  } catch {
                    // Wait for full JSON arguments in subsequent deltas or model.message
                  }
                }
              }
            }

            const delta = (event as any).content ?? (event as any).delta;
            if (delta && typeof delta === 'string') {
              receivedTokensCount += delta.length;
              callbacks?.onTokenDelta?.(delta);
            }
            break;
          }

          case 'model.message':
          case 'assistant.message': {
            const rawCalls = (event as any).tool_calls ?? (event as any).toolCalls ?? [];
            for (const call of rawCalls) {
              const callId = call.id ?? '';
              const name = call.function?.name ?? call.name ?? '';
              let args = call.function?.arguments ?? call.arguments ?? call.args ?? {};
              if (typeof args === 'string') {
                try {
                  args = JSON.parse(args);
                } catch {
                  // keep raw string if not valid JSON
                }
              }
              if (name && (!callId || !emittedToolCallIds.has(callId))) {
                if (callId) emittedToolCallIds.add(callId);
                callbacks?.onToolCall?.({
                  id: callId,
                  name,
                  args,
                });
              }
            }
            const directContent = (event as any).content ?? (event as any).text;
            if (directContent && typeof directContent === 'string' && rawCalls.length === 0) {
              receivedTokensCount += directContent.length;
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

          case 'tool.response_required': {
            const toolCalls = (event as any).toolCalls ?? [];
            for (const call of toolCalls) {
              if (currentTurnId) {
                await this.client.sessions.createTurnEvents(sessionId, currentTurnId, {
                  events: [
                    {
                      type: 'user.tool_response',
                      threadId: (event as any).threadId ?? 'main',
                      toolCallId: call.id,
                      content: JSON.stringify({ response: 'Proceed with analysis of workspace files' }),
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

          case 'error': {
            const errMsg = String((event as any).message ?? (event as any).error ?? 'Turn stream error');
            lastErrorMessage = errMsg;
            callbacks?.onError?.(new Error(errMsg));
            break;
          }

          case 'turn.done': {
            // Flush any pending tool calls from streaming deltas that weren't emitted yet
            for (const [callId, pending] of streamingToolCalls.entries()) {
              if (pending.name && !emittedToolCallIds.has(callId)) {
                let parsedArgs: unknown = {};
                try {
                  parsedArgs = pending.rawArgs ? JSON.parse(pending.rawArgs) : {};
                } catch {
                  parsedArgs = pending.rawArgs;
                }
                emittedToolCallIds.add(callId);
                callbacks?.onToolCall?.({
                  id: pending.id,
                  name: pending.name,
                  args: parsedArgs,
                });
              }
            }

            const state = (event as any).state;
            const rawStatus = state?.status ?? (event as any).status ?? 'completed';
            const errorMsg = state?.message ?? state?.error ?? (event as any).error ?? lastErrorMessage;
            const isFailure = rawStatus === 'error' || rawStatus === 'failed' || Boolean(errorMsg);

            if (isFailure && remainingRetries > 0 && errorMsg && this.isFallbackEligible(String(errorMsg))) {
              const trapped = String(errorMsg);
              if (trapped.includes('flash-lite') || trapped.includes('3.5-flash-lite')) {
                TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-flash-lite-latest');
                TrueForgeHarnessClient.quotaExhaustedModels.add('google/gemini-flash-lite-latest');
                TrueForgeHarnessClient.quotaExhaustedModels.add('google-gemini/gemini-flash-lite-latest');
              }
              if (trapped.includes('gemini-3.8-flash') || trapped.includes('gemini-3-8-flash')) {
                TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-3.8-flash');
                TrueForgeHarnessClient.quotaExhaustedModels.add('google/gemini-3-8-flash');
                TrueForgeHarnessClient.quotaExhaustedModels.add('google-gemini/gemini-3-8-flash');
              }
              if (trapped.includes('gemini-3.5-flash') || trapped.includes('gemini-3-5-flash')) {
                TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-3.5-flash');
                TrueForgeHarnessClient.quotaExhaustedModels.add('google/gemini-3-5-flash');
                TrueForgeHarnessClient.quotaExhaustedModels.add('google-gemini/gemini-3-5-flash');
              }
              if (trapped.includes('gemini-2.5-flash') || trapped.includes('gemini-2-5-flash')) {
                TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-2.5-flash');
                TrueForgeHarnessClient.quotaExhaustedModels.add('google/gemini-2-5-flash');
                TrueForgeHarnessClient.quotaExhaustedModels.add('google-gemini/gemini-2-5-flash');
              }

              const fallbackModel = this.resolveFallbackModel();
              console.warn(
                `[ModelRescue] Primary inference failure trapped: "${errorMsg}". Rescuing turn via fallback model "${fallbackModel}" (${remainingRetries - 1} retries left)...`
              );
              const preservedInstructions = this.sessionInstructions.get(sessionId);
              try {
                await this.ensureNamedAgent({ modelName: fallbackModel, instructions: preservedInstructions });
                const fallbackSessionId = await this.createSession({
                  modelName: fallbackModel,
                  instructions: preservedInstructions,
                });
                return await this.runTurn(fallbackSessionId, prompt, callbacks, abortSignal, remainingRetries - 1);
              } catch (fallbackErr) {
                console.warn('[ModelRescue] Fallback model switch failed:', fallbackErr);
              }
            }

            callbacks?.onTurnComplete?.({
              turnId: currentTurnId,
              status: isFailure ? 'failed' : rawStatus,
              error: errorMsg || undefined,
              tokensReceived: receivedTokensCount,
            });

            if (isFailure && callbacks?.onError && errorMsg) {
              callbacks.onError(new Error(String(errorMsg)));
            }
            break;
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return;
      }
      const errText = String(err?.message ?? err ?? '');
      if (remainingRetries > 0 && this.isFallbackEligible(errText)) {
        if (errText.includes('flash-lite') || errText.includes('3.5-flash-lite')) {
          TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-flash-lite-latest');
          TrueForgeHarnessClient.quotaExhaustedModels.add('google/gemini-flash-lite-latest');
          TrueForgeHarnessClient.quotaExhaustedModels.add('google-gemini/gemini-flash-lite-latest');
        }
        if (errText.includes('gemini-3.8-flash') || errText.includes('gemini-3-8-flash')) {
          TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-3.8-flash');
          TrueForgeHarnessClient.quotaExhaustedModels.add('google/gemini-3-8-flash');
          TrueForgeHarnessClient.quotaExhaustedModels.add('google-gemini/gemini-3-8-flash');
        }
        if (errText.includes('gemini-3.5-flash') || errText.includes('gemini-3-5-flash')) {
          TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-3.5-flash');
          TrueForgeHarnessClient.quotaExhaustedModels.add('google/gemini-3-5-flash');
          TrueForgeHarnessClient.quotaExhaustedModels.add('google-gemini/gemini-3-5-flash');
        }
        if (errText.includes('gemini-2.5-flash') || errText.includes('gemini-2-5-flash')) {
          TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-2.5-flash');
          TrueForgeHarnessClient.quotaExhaustedModels.add('google/gemini-2-5-flash');
          TrueForgeHarnessClient.quotaExhaustedModels.add('google-gemini/gemini-2-5-flash');
        }
        const fallbackModel = this.resolveFallbackModel();
        console.warn(
          `[ModelRescue] Primary inference failure trapped: "${errText}". Rescuing turn via fallback model "${fallbackModel}" (${remainingRetries - 1} retries left)...`
        );
        try {
          const preservedInstructions = this.sessionInstructions.get(sessionId);
          await this.ensureNamedAgent({ modelName: fallbackModel, instructions: preservedInstructions });
          const fallbackSessionId = await this.createSession({
            modelName: fallbackModel,
            instructions: preservedInstructions,
          });
          return await this.runTurn(fallbackSessionId, prompt, callbacks, abortSignal, remainingRetries - 1);
        } catch (fallbackErr) {
          console.warn('[ModelRescue] Fallback turn execution failed:', fallbackErr);
        }
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
