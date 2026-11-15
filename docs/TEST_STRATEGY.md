# FORGE//SENTINEL — TEST STRATEGY & VERIFICATION MATRIX
## Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27

---

## 1. Multi-Tier Testing Hierarchy

To meet competition quality standards, FORGE//SENTINEL is verified across four distinct tiers:

```
+-------------------------------------------------------------+
| TIER 4: Fixed Competition Benchmark Tasks                   |
| - Task A: Inline edit on Flask helpers.py (get_debug_flag)  |
| - Task B: Multi-file Agent mode on Flask (flask config CLI) |
| - Task C: Resilience & failure recovery verification        |
+------------------------------+------------------------------+
                               |
+------------------------------v------------------------------+
| TIER 3: End-to-End System & Integration Tests               |
| - TrueForge HTTP session creation & SSE event consumption   |
| - Local Sentinel MCP Server tool dispatch & approval flow   |
| - End-to-end patch generation, staging, apply, and undo     |
+------------------------------+------------------------------+
                               |
+------------------------------v------------------------------+
| TIER 2: Subsystem Tests                                     |
| - Codebase MRI symbol discovery & dependency extraction     |
| - Context Auction scoring algorithm & budget enforcement    |
| - Diff engine hunk generation, patch apply, collision check |
+------------------------------+------------------------------+
                               |
+------------------------------v------------------------------+
| TIER 1: Unit Tests (Vitest)                                 |
| - Path sanitization & boundary assertions                   |
| - Token budget counter approximations                       |
| - Command runner stdout/stderr capture & error handling     |
+-------------------------------------------------------------+
```

---

## 2. Test Execution Rules

1. **No False Claims**: A test is never marked as passed without capturing the real exit code, stdout, and execution duration.
2. **Deterministic Baselines**: The Flask test environment is strictly pinned to git commit `22d92470` (tag `3.1.3`).
3. **Workspace Isolation**: Tests run against isolated fixtures or temporary clones; the parent repository status remains pristine (`git status` clean).
