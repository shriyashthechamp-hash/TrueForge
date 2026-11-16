# FORGE//SENTINEL — Installation & Setup Guide
**Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27**

This document provides complete instructions for setting up, configuring, and verifying **FORGE//SENTINEL** from source on macOS, Linux, and Windows.

---

## 1. System Prerequisites

Before beginning, ensure your host environment meets the following requirements:

| Component | Minimum Version | Recommended Version | Verification Command |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 20.0.0` | `v20.18.0` or `v22.x` | `node --version` |
| **npm** / **pnpm** | `>= 10.0.0` | Latest | `npm --version` |
| **Python** | `>= 3.10.0` | `3.11` – `3.13` | `python3 --version` |
| **Visual Studio Code** | `>= 1.85.0` | Latest Stable | `code --version` |
| **Git** | `>= 2.30.0` | Latest | `git --version` |

---

## 2. Repository Layout & Topology

The official workspace structure comprises three isolated directories:

```text
/path/to/workspace/
├── trueforge/         # Upstream TrueForge agent harness & daemon
├── flask/             # Official competition benchmark testbed (v3.1.3)
└── FORGE-SENTINEL/    # FORGE//SENTINEL submission repository & VS Code extension
```

> [!IMPORTANT]
> Keep `trueforge/` and `flask/` isolated. All extension code, MCP tools, and audit tests reside exclusively within `FORGE-SENTINEL/`.

---

## 3. Step-by-Step Setup

### Step 1: Initialize Python Virtual Environment for Benchmark
The Flask benchmark repository requires a Python virtual environment with test dependencies installed:

```bash
cd /path/to/workspace/flask

# Create virtual environment
python3 -m venv .venv

# Activate virtual environment
# macOS / Linux:
source .venv/bin/activate
# Windows:
# .venv\Scripts\activate

# Install Flask in editable mode with development/test dependencies
pip install --upgrade pip
pip install -e .
pip install pytest pytest-cov
```

Verify that Flask is working in the virtualenv:
```bash
python -c "import flask; print(flask.__version__)"
# Expected: 3.1.3
```

---

### Step 2: Build and Start TrueForge Harness Daemon
FORGE//SENTINEL relies on TrueForge for agent session management and model inference.

1. Navigate to the `trueforge` directory:
   ```bash
   cd /path/to/workspace/trueforge
   ```

2. Install dependencies and build TrueForge packages (if not already built):
   ```bash
   pnpm install
   pnpm build
   ```

3. Launch the TrueForge daemon with network policy disabled (to allow local MCP connections):
   ```bash
   NETWORK_POLICY_ENABLED=false node packages/trueforge/dist/cli.js --port 8790
   ```

4. Verify that TrueForge is online:
   ```bash
   curl http://localhost:8790/healthz
   # Expected response: {"status":"ok","version":"0.0.0"}
   ```

---

### Step 3: Configure Google Gemini Provider inside TrueForge

> [!CAUTION]
> **Zero Credential Exposure Rule**: Never commit or hardcode model API keys into `FORGE-SENTINEL` source files. Configure `GEMINI_API_KEY` inside your gitignored `FORGE-SENTINEL/.env` file or directly inside the TrueForge configuration store.

To configure your Google Gemini provider inside TrueForge:
1. Set `GEMINI_API_KEY=<your_key>` inside `FORGE-SENTINEL/.env` (which is ignored by Git) — `FORGE//SENTINEL` will automatically register and sync `google-gemini` (`gemini-3.8-flash`) with TrueForge on startup.
2. Alternatively, configure via the TrueForge API (`PUT http://localhost:8790/api/v1/settings/model-providers`) or UI (`http://localhost:8790` > **Settings > Providers > Google Gemini**):
   - **Provider Type:** `google-gemini`
   - **Canonical FQN:** `google-gemini/gemini-3-8-flash`
   - **Underlying Model ID:** `gemini-3.8-flash`
   - **UI Display Name:** `Gemini 3.8 Flash (Google)`

> [!NOTE]
> **Google Gemini Free-Tier Data-Use Implications**: Under the Google AI Studio / Gemini Developer API terms of service, requests submitted on the unpaid **Free Tier** may be reviewed by Google reviewers and used to train or improve Google products. Never transmit production secrets, private cryptographic keys, or proprietary customer PII on the Free Tier (`FORGE//SENTINEL` automatically blocks `.env`, `.pem`, and `.key` files from indexing and MCP tool access). Paid billing is not enabled unless explicitly configured in Google Cloud / AI Studio.

Verify that the model is visible to TrueForge:
```bash
curl -s -H "Authorization: Bearer trueforge-standalone" http://localhost:8790/api/v1/models
# Output will list configured models including "google-gemini/gemini-3-8-flash" ("gemini-3.8-flash")
```

---

### Step 4: Build FORGE//SENTINEL Extension

1. Navigate to the `FORGE-SENTINEL` directory:
   ```bash
   cd /path/to/workspace/FORGE-SENTINEL
   ```

2. Install npm dependencies:
   ```bash
   npm install
   ```

3. Compile TypeScript and bundle the extension:
   ```bash
   npm run compile
   npm run build
   ```
   This generates the production bundle at `dist/extension.js`.

4. Run the automated test suite:
   ```bash
   npm test
   ```
   Expected output: **9 test files passed, 39 tests passed (0 failures)**.

---

## 4. System Health Check

Run the automated health check script to verify all 6 subsystems in seconds:

```bash
cd /path/to/workspace/FORGE-SENTINEL
./scripts/health_check.sh
```

### Verification Checklist:
- `[1/6]` TrueForge Daemon connectivity on `localhost:8790` — **ONLINE**
- `[2/6]` Groq Qwen model configured & live inference turn probe — **SUCCESSFUL**
- `[3/6]` Flask 3.1.3 benchmark testbed & virtual environment — **FOUND**
- `[4/6]` Flask CLI test suite (`pytest tests/test_cli.py -q`) — **PASSED**
- `[5/6]` VS Code extension bundle (`dist/extension.js`) — **BUILT**
- `[6/6]` Credential leak scan across source, configs, and git — **ZERO EXPOSURE**

---

## 5. Launching the Extension in VS Code

1. Open the `FORGE-SENTINEL` directory in Visual Studio Code:
   ```bash
   code /path/to/workspace/FORGE-SENTINEL
   ```
2. Press **`F5`** (or select **Run > Start Debugging** from the menu).
3. A new **Extension Development Host** window will open.
4. In the Extension Development Host window, open the `flask` repository:
   **File > Open Folder... > `/path/to/workspace/flask`**.
5. Click the **Sentinel** shield icon in the Activity Bar to open the **Sentinel Command Center**.
6. Press `Cmd+Shift+K` (macOS) or `Ctrl+Shift+K` (Windows/Linux) in any file to trigger **Inline Surgical Edit**.

