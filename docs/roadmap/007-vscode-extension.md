# VS Code Extension

## Summary

Build a VS Code extension (`@kraken/vscode`) that connects to the running Kraken daemon via its HTTP API. The extension provides a sidebar with task management, inline agent interaction, and real-time monitoring — bringing Kraken's capabilities into the editor without needing the TUI.

## Motivation

The TUI is powerful but requires a dedicated terminal. Many developers live in VS Code and would benefit from Kraken integration without context-switching. The daemon already exposes a full HTTP API — the extension is purely a client.

## Current State

- The daemon HTTP API (`http://localhost:50051`) exposes: tasks, secrets, stats, health, schedule, clean.
- The app HTTP API (`http://localhost:7899`) exposes: sessions, messages, SSE events, models.
- No VS Code integration exists.

## Architecture

### Extension Structure

```
apps/vscode/
  package.json          -- VS Code extension manifest
  src/
    extension.ts        -- activation, command registration
    daemon/
      client.ts         -- typed HTTP client for daemon API
      connection.ts     -- daemon discovery, health checks, reconnection
    app/
      client.ts         -- typed HTTP client for app API
      sse.ts            -- SSE event listener for real-time updates
    views/
      sidebar.ts        -- sidebar webview provider
      tasks.ts          -- task tree view
      sessions.ts       -- session tree view
    commands/
      ask.ts            -- "Ask Kraken" command (selection → prompt)
      schedule.ts       -- schedule a task from editor
      explain.ts        -- explain selected code
      review.ts         -- review current file
    status/
      bar.ts            -- status bar item (daemon status, active tasks)
    webview/
      app/              -- React app for sidebar webview
        index.tsx
        components/
```

### Features

#### 1. Sidebar Panel

A webview-based sidebar showing:
- **Daemon status**: connected/disconnected, uptime, port.
- **Active tasks**: list with status indicators, click to see logs.
- **Recent sessions**: conversation history, click to resume.
- **Triggers**: list configured crons/watchers/webhooks with enable/disable toggles.

#### 2. Task Management

Tree view provider for tasks:

```typescript
class TaskTreeProvider implements vscode.TreeDataProvider<TaskItem> {
  private tasks: Task[] = [];
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();

  async refresh() {
    const response = await daemonClient.listTasks({ limit: 50 });
    this.tasks = response.tasks;
    this._onDidChangeTreeData.fire();
  }
}
```

Actions: cancel, retry, view logs, view output.

#### 3. "Ask Kraken" Command

Select code in editor → Ctrl+Shift+K → input prompt → creates a session with the selected code as context:

```typescript
vscode.commands.registerCommand("kraken.ask", async () => {
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.document.getText(editor.selection);
  const prompt = await vscode.window.showInputBox({ prompt: "Ask Kraken..." });
  if (!prompt) return;

  const fullPrompt = selection
    ? `Regarding this code from ${editor.document.fileName}:\n\`\`\`\n${selection}\n\`\`\`\n\n${prompt}`
    : prompt;

  const session = await appClient.createSession("build");
  await appClient.sendMessage(session.id, fullPrompt);
  // Show response in webview or output channel
});
```

#### 4. Status Bar

Persistent status bar item showing:
- Daemon connection status (green/red dot)
- Number of active tasks
- Click to open sidebar

```typescript
const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
statusBar.text = "$(kraken) Kraken: 2 tasks";
statusBar.command = "kraken.showSidebar";
```

#### 5. Real-Time Updates via SSE

Subscribe to the app's `/event` SSE endpoint for live updates:

```typescript
class KrakenEventSource {
  private eventSource: EventSource;

  connect(appUrl: string) {
    this.eventSource = new EventSource(`${appUrl}/event`);
    this.eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.topic.startsWith("session.")) this.handleSessionEvent(data);
      if (data.topic.startsWith("part.")) this.handlePartEvent(data);
    };
  }
}
```

#### 6. Inline Diagnostics

When the agent finds issues in files, show them as VS Code diagnostics:

```typescript
const diagnosticCollection = vscode.languages.createDiagnosticCollection("kraken");
// After agent analysis:
diagnosticCollection.set(uri, [
  new vscode.Diagnostic(range, "Potential null dereference", vscode.DiagnosticSeverity.Warning),
]);
```

### Commands to Register

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `kraken.ask` | `Ctrl+Shift+K` | Ask Kraken about selected code |
| `kraken.explain` | — | Explain selected code |
| `kraken.review` | — | Review current file |
| `kraken.schedule` | — | Schedule a task |
| `kraken.showTasks` | — | Show task list |
| `kraken.showSidebar` | — | Toggle Kraken sidebar |
| `kraken.connectDaemon` | — | Connect/reconnect to daemon |

### Configuration (VS Code settings)

```json
{
  "kraken.daemonUrl": "http://localhost:50051",
  "kraken.appUrl": "http://localhost:7899",
  "kraken.autoConnect": true,
  "kraken.showStatusBar": true,
  "kraken.defaultAgent": "build"
}
```

## Tech Stack

- **Extension**: TypeScript, VS Code Extension API.
- **Sidebar webview**: React (reuse patterns from the TUI app).
- **Build**: `esbuild` for bundling the extension, `vite` for the webview.
- **Package**: `vsce` for packaging and publishing to VS Code marketplace.

## Development

Add to the monorepo as `apps/vscode/`:

```json
// apps/vscode/package.json
{
  "name": "@kraken/vscode",
  "displayName": "Kraken",
  "publisher": "galfrevn",
  "engines": { "vscode": "^1.90.0" },
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js"
}
```

## Dependencies on Other Roadmap Items

- **`@kraken/sdk`** (008): The extension should use the SDK for typed API access instead of raw fetch.
- **Unified storage** (005): All data accessible from the daemon API means the extension only needs one connection.
- **Worker health monitoring** (006): Can show resource usage per task in the sidebar.
