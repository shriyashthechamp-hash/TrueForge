import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { CodebaseMri } from '../context/CodebaseMri.js';
import type { ContextAuction } from '../context/ContextAuction.js';
import type { PatchStagingManager } from '../diff/PatchStagingManager.js';
import { SecurityBoundaryError } from '../shared/errors.js';

const execAsync = promisify(exec);

export class SentinelMcpServer {
  private httpServer: http.Server | null = null;
  private activeTransports = new Map<string, { transport: SSEServerTransport; server: Server }>();
  private port = 9099;

  constructor(
    private readonly workspaceRoot: string,
    private readonly patchManager: PatchStagingManager,
    private readonly mri: CodebaseMri,
    private readonly auction: ContextAuction,
    port = 9099
  ) {
    this.port = port;
  }

  public getPort(): number {
    return this.port;
  }

  public getSseUrl(): string {
    return `http://localhost:${this.port}/sse`;
  }

  private assertSafePath(targetPath: string): string {
    const resolved = this.patchManager.assertInsideWorkspace(targetPath);
    const baseLower = path.basename(resolved).toLowerCase();
    if (
      (baseLower === '.env' || baseLower.startsWith('.env.') || baseLower.endsWith('.pem') || baseLower.endsWith('.key')) &&
      baseLower !== '.env.example'
    ) {
      throw new SecurityBoundaryError(targetPath, `${this.workspaceRoot} (credential/secret file access blocked)`);
    }
    return resolved;
  }

  private createServer(): Server {
    const server = new Server(
      {
        name: 'forge-sentinel-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    const tools: Tool[] = [
      {
        name: 'read_file',
        description: 'Read contents of a file within the workspace. Supports start_line and end_line slicing.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative or absolute path to the file.' },
            start_line: { type: 'number', description: '1-based line number to start reading from.' },
            end_line: { type: 'number', description: '1-based line number to stop reading at.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'list_workspace_files',
        description: 'List files and directories in the workspace, with optional subdirectory filtering.',
        inputSchema: {
          type: 'object',
          properties: {
            subdirectory: { type: 'string', description: 'Optional subdirectory relative to workspace.' },
            max_depth: { type: 'number', description: 'Maximum directory recursion depth.' },
          },
        },
      },
      {
        name: 'search_workspace',
        description: 'Search for text or regex patterns across workspace files.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term or regex pattern.' },
            is_regex: { type: 'boolean', description: 'Whether the query is a regular expression.' },
            file_extension: { type: 'string', description: 'Optional extension filter e.g. ".py" or ".ts".' },
          },
          required: ['query'],
        },
      },
      {
        name: 'find_symbol',
        description: 'Find function, class, or variable declarations using the Codebase MRI symbol index.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Symbol name or substring.' },
          },
          required: ['query'],
        },
      },
      {
        name: 'inspect_file_structure',
        description: 'Inspect functions, classes, imports and test associations for a specific file.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'retrieve_code_context',
        description: 'Run the Context Auction retrieval engine to select the highest-value code for a task within token budget.',
        inputSchema: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'Task instruction or prompt.' },
            budget_tokens: { type: 'number', description: 'Token budget ceiling (default: 16000).' },
          },
          required: ['instruction'],
        },
      },
      {
        name: 'propose_file_edit',
        description: 'Stage a proposed file modification for user review. Never writes silently.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to target file.' },
            proposed_content: { type: 'string', description: 'The complete proposed content for the file.' },
            purpose: { type: 'string', description: 'One-sentence summary of what this change achieves.' },
            rationale: { type: 'string', description: 'Detailed technical justification for this edit.' },
            expected_impact: { type: 'string', description: 'Expected effect on callers, interfaces, and tests.' },
            risk_level: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Assessed risk.' },
          },
          required: ['path', 'proposed_content', 'purpose', 'rationale'],
        },
      },
      {
        name: 'propose_multi_file_edit',
        description: 'Stage coordinated edits across multiple files atomically for unified review.',
        inputSchema: {
          type: 'object',
          properties: {
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  proposed_content: { type: 'string' },
                  purpose: { type: 'string' },
                  rationale: { type: 'string' },
                },
                required: ['path', 'proposed_content', 'purpose', 'rationale'],
              },
            },
          },
          required: ['edits'],
        },
      },
      {
        name: 'get_staged_patches',
        description: 'Inspect all currently staged patches awaiting user review.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'apply_staged_patch',
        description: 'Apply a staged patch to the workspace file on disk after approval.',
        inputSchema: {
          type: 'object',
          properties: {
            patch_id: { type: 'string', description: 'ID of the staged patch to apply.' },
          },
          required: ['patch_id'],
        },
      },
      {
        name: 'revert_staged_patch',
        description: 'Revert an applied patch and restore the file to its exact original state.',
        inputSchema: {
          type: 'object',
          properties: {
            patch_id: { type: 'string', description: 'ID of the patch to revert.' },
          },
          required: ['patch_id'],
        },
      },
      {
        name: 'run_terminal_command',
        description: 'Execute a shell command inside the workspace root and capture output.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command line to execute.' },
            timeout_ms: { type: 'number', description: 'Maximum execution time in ms (default: 30000).' },
          },
          required: ['command'],
        },
      },
      {
        name: 'run_test_command',
        description: 'Execute a test command (e.g. pytest or vitest) and capture test results and status.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Test command to execute.' },
          },
          required: ['command'],
        },
      },
    ];

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;

      try {
        switch (name) {
          case 'read_file': {
            const relPath = String(args.path);
            const absPath = this.assertSafePath(relPath);
            const content = await fs.readFile(absPath, 'utf8');
            const lines = content.split('\n');

            const start = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : 1;
            const end = typeof args.end_line === 'number' ? Math.min(lines.length, args.end_line) : lines.length;

            const sliced = lines.slice(start - 1, end).join('\n');
            return {
              content: [
                {
                  type: 'text',
                  text: `File: ${relPath} (Lines ${start}-${end} of ${lines.length})\n\n${sliced}`,
                },
              ],
            };
          }

          case 'list_workspace_files': {
            const sub = typeof args.subdirectory === 'string' ? args.subdirectory : '';
            const targetDir = this.assertSafePath(sub);
            const files = await this.listDirRecursive(targetDir, typeof args.max_depth === 'number' ? args.max_depth : 4);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(files.map((f) => path.relative(this.workspaceRoot, f)), null, 2),
                },
              ],
            };
          }

          case 'search_workspace': {
            const query = String(args.query);
            const isRegex = Boolean(args.is_regex);
            const extFilter = typeof args.file_extension === 'string' ? args.file_extension : '';

            const allFiles = this.mri.getFiles();
            const matches: { file: string; line: number; match: string }[] = [];

            const regex = isRegex ? new RegExp(query, 'i') : null;

            for (const file of allFiles) {
              if (extFilter && !file.relativePath.endsWith(extFilter)) continue;
              let content = '';
              try {
                content = await fs.readFile(file.absolutePath, 'utf8');
              } catch {
                continue;
              }

              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (regex ? regex.test(line) : line.includes(query)) {
                  matches.push({
                    file: file.relativePath,
                    line: i + 1,
                    match: line.trim(),
                  });
                  if (matches.length >= 100) break;
                }
              }
              if (matches.length >= 100) break;
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ totalMatches: matches.length, matches }, null, 2),
                },
              ],
            };
          }

          case 'find_symbol': {
            const query = String(args.query);
            const symbols = this.mri.findSymbols(query);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(symbols, null, 2),
                },
              ],
            };
          }

          case 'inspect_file_structure': {
            const relPath = String(args.path);
            const meta = this.mri.getFile(relPath);
            if (!meta) {
              return {
                content: [{ type: 'text', text: `File "${relPath}" not found in MRI index.` }],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      file: meta.relativePath,
                      language: meta.language,
                      isTest: meta.isTestFile,
                      symbols: meta.symbols,
                      imports: meta.imports,
                      linkedTests: this.mri.getTestsForSource(meta.relativePath),
                      linkedSources: this.mri.getSourcesForTest(meta.relativePath),
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case 'retrieve_code_context': {
            const instruction = String(args.instruction);
            const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : undefined;
            const { receipt, contextBundle } = await this.auction.runAuction(instruction, budget);
            return {
              content: [
                {
                  type: 'text',
                  text: `=== CONTEXT SELECTION RECEIPT ===\n${JSON.stringify(receipt, null, 2)}\n\n=== RETRIEVED CODE CONTEXT ===\n${contextBundle}`,
                },
              ],
            };
          }

          case 'propose_file_edit': {
            const relPath = String(args.path);
            const absPath = this.assertSafePath(relPath);
            let existingContent = '';
            try {
              existingContent = await fs.readFile(absPath, 'utf8');
            } catch (err: any) {
              if (err.code !== 'ENOENT') throw err;
            }

            const staged = this.patchManager.stagePatch({
              filePath: relPath,
              proposedContent: String(args.proposed_content),
              purpose: String(args.purpose),
              rationale: String(args.rationale),
              expectedImpact: typeof args.expected_impact === 'string' ? args.expected_impact : undefined,
              riskLevel: args.risk_level as any,
              existingContent,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: `PATCH STAGED SUCCESSFULLY:\n- Patch ID: ${staged.patchId}\n- File: ${staged.filePath}\n- Hunks: ${staged.hunks.length}\n- Purpose: ${staged.purpose}\n\nUNIFIED DIFF:\n${staged.unifiedDiff}\n\nNotice: This change is held in staging awaiting explicit developer hunk-by-hunk review in VS Code.`,
                },
              ],
            };
          }

          case 'propose_multi_file_edit': {
            const edits = args.edits as Array<{
              path: string;
              proposed_content: string;
              purpose: string;
              rationale: string;
            }>;
            const stagedList = [];

            for (const edit of edits) {
              const absPath = this.assertSafePath(edit.path);
              let existingContent = '';
              try {
                existingContent = await fs.readFile(absPath, 'utf8');
              } catch (err: any) {
                if (err.code !== 'ENOENT') throw err;
              }

              const staged = this.patchManager.stagePatch({
                filePath: edit.path,
                proposedContent: edit.proposed_content,
                purpose: edit.purpose,
                rationale: edit.rationale,
                existingContent,
              });
              stagedList.push(staged);
            }

            return {
              content: [
                {
                  type: 'text',
                  text: `COORDINATED MULTI-FILE PATCH STAGED (${stagedList.length} files):\n` +
                    stagedList.map((s) => `• [${s.patchId}] ${s.filePath}: ${s.purpose}`).join('\n') +
                    `\n\nAll changes held in staging for developer review.`,
                },
              ],
            };
          }

          case 'get_staged_patches': {
            const all = this.patchManager.getAllStaged();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    all.map((p) => ({
                      patchId: p.patchId,
                      filePath: p.filePath,
                      status: p.status,
                      purpose: p.purpose,
                      hunksCount: p.hunks.length,
                      unifiedDiff: p.unifiedDiff,
                    })),
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case 'apply_staged_patch': {
            const patchId = String(args.patch_id);
            const res = await this.patchManager.applyPatch(patchId);
            return {
              content: [
                {
                  type: 'text',
                  text: `PATCH APPLIED SUCCESSFULLY:\n- Patch ID: ${patchId}\n- File: ${res.relativePath}\nWorkspace has been updated. Can be reverted anytime with revert_staged_patch.`,
                },
              ],
            };
          }

          case 'revert_staged_patch': {
            const patchId = String(args.patch_id);
            await this.patchManager.revertPatch(patchId);
            return {
              content: [
                {
                  type: 'text',
                  text: `PATCH REVERTED SUCCESSFULLY:\n- Patch ID: ${patchId}\nFile restored to original state.`,
                },
              ],
            };
          }

          case 'run_terminal_command':
          case 'run_test_command': {
            const cmd = String(args.command);
            const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 45000;

            const isDangerous = /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=|shutdown|reboot)\b/i.test(cmd);
            if (isDangerous) {
              return {
                content: [{ type: 'text', text: `Command blocked by Sentinel safety policy: "${cmd}"` }],
                isError: true,
              };
            }

            // Block direct file writes via terminal redirection to ensure agent changes go through patch staging
            const isWriteBypass = /(?:>|>>|\btee\b|\bsed\s+-i)/i.test(cmd) && !cmd.includes('pytest') && !cmd.includes('git');
            if (isWriteBypass && name === 'run_terminal_command') {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Command blocked by Sentinel Safety Policy: Direct file writing via shell redirection or sed is forbidden. All code modifications must be staged through "propose_file_edit" or "propose_multi_file_edit" so the developer can review hunks and approve diffs.`,
                  },
                ],
                isError: true,
              };
            }

            const startTime = Date.now();
            const venvBin = path.join(this.workspaceRoot, '.venv', 'bin');
            const customPath = `${venvBin}:${process.env.PATH ?? ''}`;
            const sanitizedEnv: NodeJS.ProcessEnv = { ...process.env, PATH: customPath };
            // Strip provider API keys from child shell environment so repository scripts cannot leak secrets
            delete sanitizedEnv.GEMINI_API_KEY;
            delete sanitizedEnv.GROQ_API_KEY;
            delete sanitizedEnv.OPENAI_API_KEY;
            delete sanitizedEnv.ANTHROPIC_API_KEY;

            const redactSecrets = (str: string): string =>
              str
                .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED_GEMINI_KEY]')
                .replace(/gsk_[A-Za-z0-9_-]{10,}/gi, '[REDACTED_GROQ_KEY]')
                .replace(/sk-[A-Za-z0-9_-]{20,}/gi, '[REDACTED_API_KEY]');

            try {
              const { stdout, stderr } = await execAsync(cmd, {
                cwd: this.workspaceRoot,
                env: sanitizedEnv,
                timeout,
                maxBuffer: 5 * 1024 * 1024,
              });
              const durationMs = Date.now() - startTime;
              return {
                content: [
                  {
                    type: 'text',
                    text: `Command executed successfully (exit code 0, duration: ${durationMs}ms):\n\nSTDOUT:\n${redactSecrets(stdout)}\n\nSTDERR:\n${redactSecrets(stderr)}`,
                  },
                ],
              };
            } catch (err: any) {
              const durationMs = Date.now() - startTime;
              return {
                content: [
                  {
                    type: 'text',
                    text: `Command failed (exit code ${err.code ?? 1}, duration: ${durationMs}ms):\n\nSTDOUT:\n${redactSecrets(err.stdout ?? '')}\n\nSTDERR:\n${redactSecrets(err.stderr ?? '')}\nERROR: ${redactSecrets(err.message ?? '')}`,
                  },
                ],
                isError: true,
              };
            }
          }

          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: "${name}"` }],
              isError: true,
            };
        }
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Tool error: ${error.message}` }],
          isError: true,
        };
      }
    });

    return server;
  }

  private async listDirRecursive(dirPath: string, maxDepth: number, currentDepth = 0): Promise<string[]> {
    if (currentDepth > maxDepth) return [];
    let entries: string[];
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      return [];
    }

    const results: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === '__pycache__') continue;
      const full = path.join(dirPath, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        results.push(full);
        const sub = await this.listDirRecursive(full, maxDepth, currentDepth + 1);
        results.push(...sub);
      } else {
        results.push(full);
      }
    }
    return results;
  }

  public async start(): Promise<void> {
    if (this.httpServer) return;

    this.httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url ?? '/', `http://localhost:${this.port}`);

      if (parsedUrl.pathname === '/sse' && req.method === 'GET') {
        const server = this.createServer();
        const transport = new SSEServerTransport('/messages', res);
        this.activeTransports.set(transport.sessionId, { transport, server });

        transport.onclose = () => {
          this.activeTransports.delete(transport.sessionId);
        };

        await server.connect(transport);
        return;
      }

      if (parsedUrl.pathname === '/messages' && req.method === 'POST') {
        const sessionId = parsedUrl.searchParams.get('sessionId');
        const session = sessionId ? this.activeTransports.get(sessionId) : Array.from(this.activeTransports.values())[0];

        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found for SSE transport' }));
          return;
        }

        await session.transport.handlePostMessage(req, res);
        return;
      }

      if (parsedUrl.pathname === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'forge-sentinel-mcp' }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    const initialPort = this.port;
    const tryListen = (targetPort: number): Promise<number> => {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: any) => {
          this.httpServer?.removeListener('error', onError);
          if (err.code === 'EADDRINUSE' && targetPort < initialPort + 50) {
            resolve(tryListen(targetPort + 1));
          } else {
            reject(err);
          }
        };

        this.httpServer?.once('error', onError);
        this.httpServer?.listen(targetPort, () => {
          this.httpServer?.removeListener('error', onError);
          this.port = targetPort;
          resolve(targetPort);
        });
      });
    };

    await tryListen(this.port);
  }

  public async stop(): Promise<void> {
    if (this.httpServer) {
      for (const { transport, server } of this.activeTransports.values()) {
        try {
          await transport.close();
        } catch {
          // ignore
        }
        try {
          await server.close();
        } catch {
          // ignore
        }
      }
      this.activeTransports.clear();

      await new Promise<void>((resolve) => {
        if (this.httpServer) {
          if (typeof (this.httpServer as any).closeAllConnections === 'function') {
            (this.httpServer as any).closeAllConnections();
          }
          this.httpServer.close(() => resolve());
        } else {
          resolve();
        }
      });
      this.httpServer = null;
    }
  }
}

