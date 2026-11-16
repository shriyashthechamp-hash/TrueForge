# FORGE//SENTINEL — Security & Safety Model
**Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27**

Security and workspace safety are core architectural pillars of **FORGE//SENTINEL**. Unlike conventional AI coding tools that execute unvetted shell commands or write directly to files, FORGE//SENTINEL implements a defense-in-depth model across the entire agent execution pipeline.

---

## 1. Zero Credential Exposure Architecture

### Threat
AI coding assistants often request API keys via environment variables or prompt dialogs, creating risks of credential leakage into repository files, git commits, build logs, and telemetry.

### Mitigation
1. **Strict Credential Quarantine:**
   - FORGE//SENTINEL contains **zero** credential storage, parsing, or hardcoded secrets.
   - All LLM credentials (e.g. Groq, OpenAI, Anthropic) reside strictly inside the isolated TrueForge daemon runtime.
   - Communication between Sentinel and TrueForge occurs over authenticated local loopback (`http://localhost:8790`), passing session requests without exposing provider API tokens to the client.
2. **Automated Credential Leak Scanners:**
   - The repository includes automated scanning in `./scripts/health_check.sh` and CI hooks checking for common secret entropy patterns (`gsk_`, `sk-`, `ghp_`, `AKIA`, etc.).

---

## 2. File Modification & Sandboxing Boundary

```text
[ LLM Agent Turn ]
        │
        ▼ (Proposes Edit)
[ Sentinel MCP Server ] 
        │ (Boundary Check: Root Traversal / Symlink Escapes)
        ▼
[ PatchStagingManager ] (In-Memory Staging, Unified Diff, Cryptographic Hash)
        │
        ▼ (Presents Native vscode.diff)
[ Developer Review & Approval ]
        │
        ├── Reject ───► Workspace Untouched (0 Writes)
        │
        └── Approve ──► [ SHA-256 Conflict Check ]
                             │
                             ├── Hash Mismatch ──► ABORT (External Conflict)
                             │
                             └── Hash Verified ──► Transactional Apply + Flight Recorder Journal
```

### 1. Workspace Root Path Traversal Prevention
Every file operation requested via the MCP server (`read_file`, `propose_file_edit`, etc.) passes through `assertPathWithinWorkspace()`:
- Paths are canonicalized using `path.resolve()`.
- Paths containing directory traversal sequences (e.g., `../../etc/passwd`) or symlinks resolving outside the root directory throw an immediate security exception:
  ```typescript
  if (!resolvedPath.startsWith(workspaceRoot)) {
    throw new Error(`Access denied: path outside workspace root (${targetPath})`);
  }
  ```

### 2. Transactional Staging & Zero Silent Writes
- The agent has **no direct filesystem write privileges**.
- Edits are proposed as unified diffs and staged in memory within `PatchStagingManager`.
- No modification touches the user's disk until the developer explicitly reviews and accepts the hunks in the native VS Code diff editor.

### 3. External Modification & Conflict Detection
- When a patch is staged, `PatchStagingManager` captures the file's current modification timestamp (`mtime`) and SHA-256 content checksum.
- Prior to applying an approved patch, the file is re-hashed. If an external process, git branch switch, or developer manual edit modified the file in the interim, the operation is aborted with a clear conflict warning.

### 4. Selective Hunk Rollback
- Reverting a staged or applied hunk rolls back only the target lines, preserving valid sibling changes in the same file or across the workspace.

---

## 3. Shell Execution Containment

### Threat
AI models attempting to bypass patch staging tools by invoking shell commands that write directly to disk (e.g. `echo "foo" > main.py`, `cat << 'EOF' > test.py`, `sed -i`, `rm -rf`).

### Mitigation
1. **Command Inspection & Write Redirection Blocking:**
   - Sentinel's `run_terminal_command` tool inspects command tokens before execution.
   - Output redirection operators (`>`, `>>`, `tee`) and in-place file mutation flags (`sed -i`) are blocked with security errors directing the agent to use `propose_file_edit`.
2. **Execution Sandboxing:**
   - Non-interactive execution with strict execution timeouts.
   - Commands execute with standard user permissions inside the project root, never elevated (`sudo` commands are rejected).

---

## 4. Recursive Configuration Secret Masking

### Threat
CLI inspection commands (e.g., `flask config`) displaying application settings may inadvertently output database passwords, encryption keys, and third-party API tokens stored in nested configuration objects.

### Mitigation
FORGE//SENTINEL enforces recursive dictionary and collection traversal:
1. **Case-Insensitive Substring Matching:**
   Any configuration key containing `SECRET`, `PASSWORD`, `TOKEN`, or `KEY` is matched case-insensitively (e.g., `DATABASE_PASSWORD`, `jwt_token`, `SecretKey`).
2. **Recursive Arbitrary Depth:**
   - Dictionaries nested inside dictionaries.
   - Dictionaries nested inside lists or tuples.
   - Lists nested inside dictionaries.
3. **Redaction Pattern:**
   Sensitive values are replaced with `"***"` (or `"******"`) while preserving dictionary keys, non-sensitive entries, and valid JSON structure.
4. **Verified Test Coverage:**
   The implementation is verified by 7 dedicated test scenarios in `tests/test_cli.py`, confirming zero secret leakage across all levels of nesting.

---

## 5. Audit Logging & Flight Recorder

Every action executed by FORGE//SENTINEL is recorded in the **Flight Recorder** journal:
- Session ID, turn ID, and timestamp.
- Context Selection Receipt (exact files and symbols provided to the model).
- MCP tool calls, input arguments, and returned results.
- Pre-edit and post-edit SHA-256 checksums of all touched files.
- Test verification commands, exit codes, and stdout/stderr output.
- Proof-of-Change verification reports.

The audit log is stored locally within `.sentinel/flight_recorder.json` and is never transmitted to external telemetry servers.

