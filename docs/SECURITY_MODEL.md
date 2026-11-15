# FORGE//SENTINEL — SECURITY MODEL & SAFETY INVARIANTS
## Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27

---

## 1. Zero Direct Credentials Principle
- FORGE//SENTINEL strictly rejects handling, requesting, printing, or caching model provider credentials (e.g. OpenAI, Anthropic, Gemini, Groq API keys).
- All model keys and catalog bindings reside strictly within TrueForge configuration.
- The extension communicates with TrueForge solely via authenticated localhost HTTP/SSE using the configured TrueForge service token (`trueforge-standalone` by default).

---

## 2. Filesystem Boundary Enforcement
- Every path requested via tool calls (`read_file`, `propose_file_edit`, `search_workspace`) undergoes strict normalization via `path.resolve` against the active workspace root (`vscode.workspace.workspaceFolders`).
- Any attempt to escape the workspace root via relative sequences (e.g. `../../etc/passwd`), null bytes, or symlinks to outside directories triggers an immediate security error:
  ```typescript
  export function assertPathInWorkspace(targetPath: string, workspaceRoot: string): string {
    const resolved = path.resolve(workspaceRoot, targetPath);
    if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
      throw new SecurityError(`Access denied: path "${targetPath}" escapes workspace root "${workspaceRoot}".`);
    }
    return resolved;
  }
  ```

---

## 3. Sandboxed & Controlled Execution
- Commands executed via `run_terminal_command` or `run_test_command` are bound to `cwd = workspaceRoot`.
- Risky shell commands (e.g. `rm -rf /`, `mkfs`, `sudo`, `chmod -R 777`) require explicit interactive approval or are rejected outright.
- Execution produces sanitized, bounded stdout/stderr outputs to prevent memory overflow or log injection.

---

## 4. Staged Patch Invariant & Immutability
- The AI agent has **zero direct write access** to the filesystem.
- All file edits are staged as unified diff hunks inside an in-memory `PatchStagingManager`.
- A patch is applied only when:
  1. The user explicitly clicks "Accept" in the VS Code review UI.
  2. The target file's SHA-256 matches the baseline captured when the patch was proposed (optimistic concurrency check).
  3. The change is executed through `vscode.WorkspaceEdit`, keeping the change completely reversible on VS Code's native undo stack.

---

## 5. Webview Isolation & Content Security Policy
- Custom Webviews operate with `enableScripts: true` but enforce a strict Content Security Policy.
- Only local extension resources with randomized, cryptographically strong `nonce` attributes may execute scripts.
- No remote external scripts, inline event handlers, or external frames are permitted.
