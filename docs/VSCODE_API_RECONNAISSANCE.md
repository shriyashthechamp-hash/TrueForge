# VS CODE EXTENSION API RECONNAISSANCE & ARCHITECTURAL SPECIFICATION
## Techfest IIT Bombay × TrueFoundry Forge-a-thon 2026–27
### FORGE//SENTINEL Native VS Code Integration Architecture

---

## 1. Overview & Architectural Philosophy

FORGE//SENTINEL is engineered as a first-class, native Visual Studio Code extension. It is not an embedded iframe or webview simulating an IDE. It leverages official VS Code Extension APIs (`vscode`) to interact with the active workspace, active editors, native diff viewers, and the language server subsystem.

All native interactions adhere strictly to Microsoft's VS Code UX Guidelines and Extension Guidelines.

---

## 2. API Selection, Mechanics & Justification

### 2.1 Extension Activation & Lifecycle
- **Entry Points**: `activate(context: vscode.ExtensionContext)` and `deactivate()`.
- **Activation Events**:
  - `onView:forge-sentinel.agentPanel` (lazily loads when the Sentinel view is opened)
  - `onCommand:forge-sentinel.inlineEdit`
  - `onCommand:forge-sentinel.openPanel`
  - `workspaceContains:**/*`
- **Disposables**: All subscriptions, registered providers, and event handlers are added to `context.subscriptions` to ensure zero memory leaks upon reload or deactivation.

### 2.2 Activity Bar & Custom Container Registration
- **Contribution Point (`package.json`)**:
  ```json
  "viewsContainers": {
    "activitybar": [
      {
        "id": "forge-sentinel-container",
        "title": "FORGE//SENTINEL",
        "icon": "media/sentinel-icon.svg"
      }
    ]
  },
  "views": {
    "forge-sentinel-container": [
      {
        "type": "webview",
        "id": "forge-sentinel.agentPanel",
        "name": "Sentinel Command Center"
      },
      {
        "type": "tree",
        "id": "forge-sentinel.flightRecorder",
        "name": "Agent Flight Recorder"
      },
      {
        "type": "tree",
        "id": "forge-sentinel.codebaseMri",
        "name": "Codebase MRI"
      }
    ]
  }
  ```

### 2.3 TextEditor & Selection APIs (Inline Edit)
- **Active Editor Inspection**:
  - `vscode.window.activeTextEditor` captures document URI, languageId, visible ranges, and current cursor selection (`editor.selection`).
  - Selected text range extracted via `editor.document.getText(editor.selection)`.
- **Instruction Input**:
  - Clean `vscode.window.showInputBox` with prompt and placeholder:
    `"e.g. Treat the values 'off' and 'n' as false as well, case-insensitively..."`
- **Keybinding**:
  - `Cmd+Shift+K` (macOS) / `Ctrl+Shift+K` (Windows/Linux) mapped to `forge-sentinel.inlineEdit` when `editorTextFocus`.

### 2.4 Native Diff Editor Integration (`vscode.diff`)
- **Review Workflow**:
  Instead of rendering fragile markdown diffs inside a chat box, FORGE//SENTINEL opens VS Code's native side-by-side diff editor:
  ```typescript
  await vscode.commands.executeCommand(
    "vscode.diff",
    originalFileUri,
    proposedStagedFileUri,
    `Sentinel Review: ${path.basename(originalFileUri.fsPath)} (Proposed)`
  );
  ```
- **Hunk-by-Hunk Precision**:
  Proposed diffs are also represented as structured unified diff hunks with line numbers. Users can accept all changes or selectively apply hunks.

### 2.5 Workspace & Controlled Document Modifications
- **Safety Rule**: Never use `fs.writeFileSync` or silent writes for proposed code.
- **Transactional Application**:
  Use `vscode.WorkspaceEdit`:
  ```typescript
  const edit = new vscode.WorkspaceEdit();
  edit.replace(documentUri, targetRange, replacementText);
  const success = await vscode.workspace.applyEdit(edit);
  ```
  This preserves the user's native VS Code Undo stack (`Cmd+Z` / `Ctrl+Z`), ensuring any accepted change can be instantly and safely reversed by the developer.

### 2.6 Webview Panels & Webview Views (Security & CSP)
- **Webview Provider**: Implements `vscode.WebviewViewProvider` (`resolveWebviewView`).
- **Strict Content Security Policy (CSP)**:
  ```html
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src ${webview.cspSource} 'nonce-${nonce}';
    img-src ${webview.cspSource} https:;
    font-src ${webview.cspSource};
  ">
  ```
- **Inter-Process Communication**:
  - Webview to Extension: `vscode.postMessage(message)` validated with schema guards.
  - Extension to Webview: `webviewView.webview.postMessage(data)`.
  - Zero DOM manipulation outside the isolated webview.

### 2.7 Cancellation Handling (`vscode.CancellationToken`)
- Long-running operations (repository indexing, TrueForge turns, test execution) take `vscode.CancellationToken` or connect to `AbortController`.
- When the user clicks "Cancel" in the UI or invokes `forge-sentinel.cancelTurn`, the token fires, halting the TrueForge SSE stream and local MCP operations without leaving partial edits.

### 2.8 Repository Intelligence (Codebase MRI)
- Employs `vscode.workspace.findFiles`, `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)`, and language AST analysis.
- Builds an indexed graph of symbols, classes, functions, and cross-file imports without blocking the UI thread.

---

## 3. Threat Model & Security Boundaries

1. **Workspace Trust**:
   - `package.json` configures `"capabilities": { "untrustedWorkspaces": { "supported": "limited" } }`. In untrusted workspaces, terminal execution and write tools are disabled.
2. **Filesystem Boundaries**:
   - All tool paths are resolved using `path.resolve` and verified to ensure they reside strictly within `vscode.workspace.workspaceFolders`.
   - Any path escaping the workspace (via `..` traversal or absolute path spoofing) is rejected with an explicit security violation.
3. **Command Sanitization**:
   - Terminal commands executed via MCP are inspected. Potentially destructive commands (`rm -rf /`, `format`, pipe to shell) require explicit confirmation.
