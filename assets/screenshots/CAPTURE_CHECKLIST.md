# FORGE//SENTINEL — Extension UI Screenshot Capture Guide

This guide provides instructions and checklists for capturing high-fidelity product screenshots from the active **FORGE//SENTINEL** Extension Development Host inside Visual Studio Code.

---

## Prerequisites for Capture
1. Ensure the TrueForge daemon is running:
   ```bash
   NETWORK_POLICY_ENABLED=false node trueforge/packages/trueforge/dist/cli.js --port 8790
   ```
2. Build the extension bundle:
   ```bash
   cd FORGE-SENTINEL
   npm run compile && npm run build
   ```
3. Open `FORGE-SENTINEL` in VS Code and press `F5` to open the Extension Development Host window.
4. In the Extension Development Host window, open the `flask` testbed workspace:
   `File > Open Folder... > /Users/shriyasdeshmukh/True_Forge_IIT_BOM/flask`

---

## Screenshot Inventory & Capture Checklist

### 1. `01_sentinel_command_center.png`
- **Location:** Sentinel Activity Bar Icon (`Sentinel` shield icon in primary sidebar).
- **View:** Sentinel Command Center Webview (`SentinelSidebarViewProvider`).
- **Elements to Display:**
  - Status banner showing `TrueForge: Connected` (`localhost:8790`) and active model `groq/qwen-3-8-27b`.
  - Mode toggle: `Agent Mode` vs `Inline Edit`.
  - Prompt input area with `@file` and `@symbol` autocomplete pill tags.
  - Active session thread showing streaming progress and tool invocation cards.
- **Action:** Type `@file:src/flask/cli.py Implement config command with recursive masking` and trigger run.

### 2. `02_codebase_mri_graph.png`
- **Location:** Secondary sidebar or Sentinel TreeView (`Codebase MRI Explorer`).
- **View:** Symbol hierarchy and dependency graph.
- **Elements to Display:**
  - AST symbol nodes: `get_debug_flag` (Function), `Flask` (Class), `Config` (Class).
  - Dependency edges and topological sort status.
  - Test linkage badge (`tests/test_cli.py` mapped to `src/flask/cli.py`).
  - Indexing health indicator (`Indexed in 17.8ms`).

### 3. `03_inline_surgical_diff.png`
- **Location:** Active editor on `src/flask/helpers.py`.
- **View:** Surgical inline edit triggered via `Cmd+Shift+K` (macOS) / `Ctrl+Shift+K` (Linux/Windows).
- **Elements to Display:**
  - Selected range around `get_debug_flag()` definition.
  - Inline input prompt overlay with query: `"Treat 'off' and 'n' as false, case-insensitively"`.
  - Staged inline diff overlay showing green insertion of `.lower() in ("0", "false", "no", "off", "n")` and red deletion.
  - Accept (`✓ Accept Hunk`) and Reject (`✗ Discard`) action buttons.

### 4. `04_context_auction_receipt.png`
- **Location:** Flight Recorder / Inspection Panel.
- **View:** Context Selection Receipt JSON rendered in UI.
- **Elements to Display:**
  - Token Budget: `4,000 tokens` total, `2,800 tokens` packed context, `1,200 tokens` reserved overhead.
  - Candidate bidding scores: `src/flask/helpers.py` (Score: 1.0, Reason: Explicit reference), `src/flask/cli.py` (Score: 0.88, Reason: AST caller).
  - Sub-file snippet extraction badge (`Lines 20–45 extracted for get_debug_flag`).

### 5. `05_native_diff_review.png`
- **Location:** VS Code Native Diff Editor (`vscode.diff`).
- **View:** Side-by-side comparison between `original: src/flask/cli.py` and `staged: src/flask/cli.py`.
- **Elements to Display:**
  - Split view with syntax highlighting.
  - Highlighted addition of `config_command` with `@click.command("config")` and recursive secret masking function `_mask_value()`.
  - Top editor action bar buttons: `Sentinel: Apply Staged Patch` and `Sentinel: Discard Staged Patch`.

### 6. `06_proof_of_change_report.png`
- **Location:** Sentinel Output Channel / Flight Recorder Webview.
- **View:** Proof-Carrying Code execution summary.
- **Elements to Display:**
  - Test command: `pytest tests/test_cli.py -q`.
  - Execution result: `56 passed, 3 skipped in 0.07s (Exit Code: 0)`.
  - Cryptographic state confirmation: SHA-256 pre-edit and post-edit checksums.
  - Transaction status: `PROVEN & COMMITTED`.

---

## Capture Guidelines
- **Resolution:** Capture at Retina 2x scale (minimum 1920×1080 or active window bounds).
- **Theme:** Default Dark Modern or GitHub Dark High Contrast for maximum visual clarity.
- **Format:** Optimized PNG format.
- **Storage:** Save files to `FORGE-SENTINEL/assets/screenshots/`.

