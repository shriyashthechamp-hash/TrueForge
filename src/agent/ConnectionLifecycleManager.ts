import { TrueForgeHarnessClient } from './TrueForgeHarnessClient.js';
import { SentinelMcpServer } from '../mcp/SentinelMcpServer.js';

export type ConnectionState = 'connected' | 'degraded_mcp' | 'degraded_daemon' | 'disconnected';

export interface DetailedConnectionStatus {
  state: ConnectionState;
  connected: boolean; // True ONLY if state === 'connected' (both TrueForge and Sentinel MCP are online and in sync)
  daemonOnline: boolean;
  daemonVersion?: string;
  mcpOnline: boolean;
  mcpSynchronized: boolean;
  activeModel?: string;
  modelName?: string;
  models?: Array<{ name: string; displayName: string; isAvailable: boolean }>;
  error?: string;
}

export class ConnectionLifecycleManager {
  private timer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private currentBackoffMs = 2000;
  private readonly minBackoffMs = 2000;
  private readonly maxBackoffMs = 10000;
  private readonly connectedHeartbeatMs = 15000;
  private lastStatus: DetailedConnectionStatus | null = null;
  private preferredModel?: string;

  public setPreferredModel(modelName?: string): void {
    this.preferredModel = modelName;
  }

  constructor(
    private readonly trueforge: TrueForgeHarnessClient,
    private readonly mcpServer: SentinelMcpServer,
    private readonly workspaceRoot?: string,
    private readonly onStatusChange?: (status: DetailedConnectionStatus) => void
  ) {}

  public async checkStatus(): Promise<DetailedConnectionStatus> {
    let daemonOnline = false;
    let daemonVersion: string | undefined;
    let mcpOnline = false;
    let mcpSynchronized = false;
    let activeModel: string | undefined;
    let modelName: string | undefined;
    let models: Array<{ name: string; displayName: string; isAvailable: boolean }> | undefined;
    let errorMessage: string | undefined;

    // 1. Probe Sentinel MCP server locally
    try {
      mcpOnline = await this.trueforge.checkMcpServerHealth(this.mcpServer.getHealthUrl());
    } catch {
      mcpOnline = false;
    }

    // If MCP is not listening but expected to run, attempt restart if server object exists
    if (!mcpOnline) {
      try {
        await this.mcpServer.start();
        mcpOnline = await this.trueforge.checkMcpServerHealth(this.mcpServer.getHealthUrl());
      } catch (err: any) {
        errorMessage = err.message;
      }
    }

    // 2. Probe TrueForge daemon
    try {
      const health = await this.trueforge.checkHealth();
      daemonOnline = health.status === 'ok';
      daemonVersion = health.version;
    } catch {
      daemonOnline = false;
    }

    // 3. If TrueForge is online, ensure provider & synchronize MCP server registration
    if (daemonOnline) {
      try {
        await this.trueforge.ensureGeminiProviderConfigured(undefined, this.workspaceRoot);
      } catch (err) {
        console.warn('[ConnectionLifecycle] Gemini provider configuration notice:', err);
      }

      if (mcpOnline) {
        try {
          const syncResult = await this.trueforge.ensureMcpServerSynchronized(this.mcpServer.getSseUrl());
          mcpSynchronized = syncResult.synchronized;
        } catch (err: any) {
          mcpSynchronized = false;
          errorMessage = `MCP synchronization failed: ${err.message}`;
        }
      }

      try {
        const authoritative = await this.trueforge.resolveAuthoritativeModel(this.preferredModel);
        activeModel = authoritative.displayName;
        modelName = authoritative.name;
        const available = await this.trueforge.getAvailableModels();
        models = available.map((m) => ({
          name: m.name,
          displayName: m.displayName,
          isAvailable: m.isAvailable,
        }));
      } catch (err: any) {
        console.warn('[ConnectionLifecycle] Model resolution notice:', err);
      }
    }

    // 4. Derive authoritative consolidated state
    let state: ConnectionState = 'disconnected';
    if (daemonOnline && mcpOnline && mcpSynchronized) {
      state = 'connected';
      errorMessage = undefined;
    } else if (daemonOnline && (!mcpOnline || !mcpSynchronized)) {
      state = 'degraded_mcp';
      const baseErr = !mcpOnline
        ? `Sentinel MCP server offline on port ${this.mcpServer.getPort()}`
        : `Sentinel MCP server not synchronized on TrueForge`;
      errorMessage = errorMessage ? `${baseErr} (${errorMessage})` : baseErr;
    } else if (!daemonOnline && mcpOnline) {
      state = 'degraded_daemon';
      const baseErr = `TrueForge daemon unreachable on ${this.trueforge.getBaseUrl()}`;
      errorMessage = errorMessage ? `${baseErr} (${errorMessage})` : baseErr;
    } else {
      state = 'disconnected';
      const baseErr = `TrueForge daemon (${this.trueforge.getBaseUrl()}) and Sentinel MCP server (port ${this.mcpServer.getPort()}) are both unreachable`;
      errorMessage = errorMessage ? `${baseErr} (${errorMessage})` : baseErr;
    }

    const status: DetailedConnectionStatus = {
      state,
      connected: state === 'connected',
      daemonOnline,
      daemonVersion,
      mcpOnline,
      mcpSynchronized,
      activeModel,
      modelName,
      models,
      error: state === 'connected' ? undefined : errorMessage,
    };

    this.lastStatus = status;
    this.onStatusChange?.(status);
    return status;
  }

  public startMonitoring(): void {
    if (this.timer || this.isDisposed) return;

    const scheduleNext = () => {
      if (this.isDisposed) return;
      const isConnected = this.lastStatus?.state === 'connected';
      const delay = isConnected ? this.connectedHeartbeatMs : this.currentBackoffMs;

      this.timer = setTimeout(async () => {
        try {
          const status = await this.checkStatus();
          if (status.state === 'connected') {
            this.currentBackoffMs = this.minBackoffMs;
          } else {
            this.currentBackoffMs = Math.min(Math.round(this.currentBackoffMs * 1.5), this.maxBackoffMs);
          }
        } catch (err) {
          console.warn('[ConnectionLifecycle] Error during background probe:', err);
          this.currentBackoffMs = Math.min(Math.round(this.currentBackoffMs * 1.5), this.maxBackoffMs);
        } finally {
          scheduleNext();
        }
      }, delay);
    };

    // Run first check immediately
    this.checkStatus().finally(() => {
      scheduleNext();
    });
  }

  public async triggerImmediateCheck(): Promise<DetailedConnectionStatus> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const status = await this.checkStatus();
    if (!this.isDisposed) {
      this.currentBackoffMs = status.state === 'connected' ? this.minBackoffMs : this.currentBackoffMs;
      this.startMonitoring();
    }
    return status;
  }

  public getLastStatus(): DetailedConnectionStatus | null {
    return this.lastStatus;
  }

  public dispose(): void {
    this.isDisposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
