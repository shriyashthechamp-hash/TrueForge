# FORGE//SENTINEL — Competition Demonstration Walkthrough Guide
**Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27**

This guide provides step-by-step instructions for reproducing the official competition demonstration acts. Both **Automated CLI Run** and **Interactive VS Code UI Execution** are documented.

---

## Quick Demo: Automated CLI Runner (1-Minute Evaluation)

To run the complete 3-Act competition demonstration in an automated, verifiable runner:

```bash
cd /Users/shriyasdeshmukh/True_Forge_IIT_BOM/FORGE-SENTINEL
./scripts/run_demo.sh
```

### Expected Output Summary:
```text
====================================================================
  FORGE//SENTINEL — COMPETITION DEMONSTRATION RUNNER                
  Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27            
====================================================================

▶ ACT 1: INLINE SURGICAL EDIT (Task A)
  Instruction: "Treat values 'off' and 'n' as false, case-insensitively, in get_debug_flag"
  Target: src/flask/helpers.py:28
  Running verification command: FLASK_DEBUG=off python -c 'from flask.helpers import get_debug_flag; print(get_debug_flag())'
  ✓ ACT 1 VERIFIED: get_debug_flag correctly returns False for 'off', 'n', and 'Off'.

▶ ACT 2: AUTONOMOUS AGENT MODE (Task B)
  Requirement: Built-in 'flask config' command across >= 3 files with recursive secret redaction.
  Inspecting modified files in testbed...
 M docs/cli.rst
 M src/flask/cli.py
 M tests/test_cli.py
  Verifying 'flask --help' registration...
  config  Show the application configuration.
  routes  Show the routes for the app.
  run     Run a development server.
  Running complete CLI pytest suite...
...............................................ss.s........              [100%]
56 passed, 3 skipped in 0.07s
  Testing live JSON masking with nested secret dictionary...
  ✓ RECURSIVE SECRET MASKING VERIFIED: 100% compliance.

▶ ACT 3: RESILIENCE & WORKSPACE IMMUTABILITY (Task C)
  Verifying ModelRescue backoff and workspace immutability upon turn cancellation...
 ✓ tests/e2e_benchmark_suite.test.ts (5 tests | 2 skipped)
   ✓ Task C1: Traps unreachable TrueForge daemon with exponential backoff
   ✓ Task C2: Recovers from invalid model configuration without credential leakage
   ✓ Task C3: Immediate mid-stream cancellation preserves workspace immutability

====================================================================
  ALL 3 DEMONSTRATION ACTS SUCCESSFULLY VERIFIED                    
====================================================================
```

---

## Interactive VS Code UI Walkthrough (Manual Judge Evaluation)

### Act 1: Inline Surgical Edit (Task A)

**Objective:** Modify `get_debug_flag` to treat `"off"` and `"n"` as `False` case-insensitively, using a minimal diff with interactive review.

1. In the Extension Development Host, open `src/flask/helpers.py`.
2. Navigate to line 22 where `get_debug_flag()` is defined:
   ```python
   def get_debug_flag() -> bool:
       val = os.environ.get("FLASK_DEBUG")
       if not val:
           return False
       return val.lower() not in ("0", "false", "no")
   ```
3. Highlight lines 22–32 and press **`Cmd+Shift+K`** (macOS) or **`Ctrl+Shift+K`** (Linux/Windows).
4. In the floating Sentinel input palette, type:
   `Treat values 'off' and 'n' as false, case-insensitively.`
5. Press `Enter`.
6. **Observe Sentinel Behavior:**
   - Codebase MRI confirms no breaking signature changes to `get_debug_flag`.
   - Context Auction extracts only lines 20–35 rather than the whole file.
   - An inline diff overlay appears in the editor:
     ```diff
     -    return val.lower() not in ("0", "false", "no")
     +    return val.lower() not in ("0", "false", "no", "off", "n")
     ```
   - Click **`Accept Hunk`** (or press `Enter`).
7. **Verification:**
   Run the terminal command in the integrated terminal:
   ```bash
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   # Output: False
   FLASK_DEBUG=n python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
   # Output: False
   ```

---

### Act 2: Autonomous Multi-File Agent Mode (Task B)

**Objective:** Autonomously discover codebase topology, plan changes across CLI, tests, and documentation, and implement `flask config` with recursive secret redaction.

1. Open the **Sentinel Command Center** sidebar (Shield icon in Activity Bar).
2. Select **Agent Mode**.
3. In the prompt box, enter:
   ```text
   Add a built-in 'flask config' CLI command that outputs application configuration as JSON.
   Mask any key containing SECRET, PASSWORD, TOKEN, or KEY recursively across nested dictionaries and lists.
   Add documentation and comprehensive pytest unit tests.
   ```
4. Click **Run Agent** (`Cmd+Enter`).
5. **Observe Sentinel Autonomous Loop:**
   - **MRI Discovery:** Sentinel executes `search_workspace` and `find_symbol` through the Sentinel MCP server to locate `cli.py`, `docs/cli.rst`, and `tests/test_cli.py`.
   - **Context Auction:** Assembles relevant AST slices with a formal Context Selection Receipt.
   - **Patch Staging:** Stages multi-file patches without modifying the workspace directly:
     - `src/flask/cli.py`: Adds `config_command` and recursive masking function `_mask_value()`.
     - `docs/cli.rst`: Documents `flask config` usage.
     - `tests/test_cli.py`: Adds 7 comprehensive test functions covering nested structures and mixed-case keys.
   - **Diff Review:** Staged diffs open in side-by-side `vscode.diff` editors for user review.
   - **Click "Apply All Staged Patches"**.
   - **Proof-Carrying Code Verification:** Sentinel automatically triggers `pytest tests/test_cli.py -q` and displays the verified green execution receipt.
6. **Manual Verification:**
   ```bash
   flask --help
   # Verify 'config' is listed under Commands
   
   flask config
   # Verify valid JSON output
   
   pytest tests/test_cli.py -q
   # Verify all 56 tests pass
   ```

---

### Act 3: Resilience, Conflict Detection & Cancellation (Task C)

**Objective:** Prove system safety under adverse conditions: network failure, external conflict, and mid-stream cancellation.

#### C1: Daemon Down Resiliency
1. Simulate TrueForge daemon offline by stopping or blocking port 8790.
2. Submit a request in Sentinel.
3. Observe **Model Rescue**: Bounded exponential backoff logs retries with clear UI notification rather than silent crashing.

#### C2: Mid-Stream Cancellation & Workspace Immutability
1. In Agent Mode, trigger a complex multi-file prompt.
2. While tokens and MCP tool calls are streaming in real-time, click **Cancel** (`Stop` icon).
3. Observe:
   - The SSE stream terminates immediately via `AbortController`.
   - The workspace remains **100% clean and unmodified** — zero partial writes or orphaned temporary files.

#### C3: External Modification & Conflict Rejection
1. Stage a patch on `src/flask/cli.py`.
2. In an external terminal or editor, touch or append a line to `src/flask/cli.py`.
3. Attempt to apply the staged patch in Sentinel.
4. Sentinel's SHA-256 conflict detection rejects the patch with:
   `Error: File src/flask/cli.py has been modified externally since patch generation.`
   Preventing silent overwrites and code corruption.

