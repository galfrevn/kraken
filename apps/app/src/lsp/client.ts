import { JsonRpcTransport } from "./jsonrpc.ts";
import type { Diagnostic, PublishDiagnosticsParams } from "./types.ts";

interface LspClientOptions {
  serverName: string;
  command: string[];
  rootUri: string;
  env?: Record<string, string>;
}

export class LspClient {
  private options: LspClientOptions;
  private transport: JsonRpcTransport | null = null;
  private process: import("bun").Subprocess | null = null;
  private diagnosticsCache = new Map<string, Diagnostic[]>();
  private openFiles = new Map<string, number>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private crashed = false;

  constructor(options: LspClientOptions) {
    this.options = options;
  }

  get serverName(): string {
    return this.options.serverName;
  }

  get isRunning(): boolean {
    return this.transport !== null && !this.crashed;
  }

  async start(): Promise<void> {
    const [cmd, ...args] = this.options.command;
    if (!cmd) throw new Error(`empty command for ${this.options.serverName}`);

    this.process = Bun.spawn([cmd, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...this.options.env },
    });

    this.transport = new JsonRpcTransport(this.process);

    this.transport.onNotification("textDocument/publishDiagnostics", (params) => {
      const diagnosticParams = params as PublishDiagnosticsParams;
      this.diagnosticsCache.set(diagnosticParams.uri, diagnosticParams.diagnostics);
      const waiters = this.diagnosticWaiters.get(diagnosticParams.uri);
      if (waiters) {
        for (const resolve of waiters) resolve();
        this.diagnosticWaiters.delete(diagnosticParams.uri);
      }
    });

    this.process.exited.then(() => {
      this.crashed = true;
    });

    await this.transport.request("initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true, didClose: true },
          publishDiagnostics: { relatedInformation: false },
        },
      },
      rootUri: this.options.rootUri,
      workspaceFolders: [{ uri: this.options.rootUri, name: "workspace" }],
    });

    this.transport.notify("initialized", {});
  }

  async notifyDidOpen(filePath: string, languageId: string, content: string): Promise<void> {
    if (!this.transport) return;
    const uri = pathToUri(filePath);
    const version = 1;
    this.openFiles.set(uri, version);
    this.transport.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text: content },
    });
  }

  async notifyDidChange(filePath: string, content: string): Promise<void> {
    if (!this.transport) return;
    const uri = pathToUri(filePath);
    const currentVersion = this.openFiles.get(uri) ?? 0;
    const nextVersion = currentVersion + 1;
    this.openFiles.set(uri, nextVersion);
    this.transport.notify("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: content }],
    });
  }

  async notifyDidClose(filePath: string): Promise<void> {
    if (!this.transport) return;
    const uri = pathToUri(filePath);
    this.openFiles.delete(uri);
    this.transport.notify("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  getDiagnostics(filePath: string): Diagnostic[] {
    return this.diagnosticsCache.get(pathToUri(filePath)) ?? [];
  }

  async waitForDiagnostics(filePath: string, timeoutMs: number): Promise<Diagnostic[]> {
    const uri = pathToUri(filePath);
    const existing = this.diagnosticsCache.get(uri);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.diagnosticWaiters.set(uri, waiters);
    });

    return this.diagnosticsCache.get(uri) ?? existing ?? [];
  }

  isFileOpen(filePath: string): boolean {
    return this.openFiles.has(pathToUri(filePath));
  }

  async shutdown(): Promise<void> {
    if (!this.transport || !this.process) return;
    try {
      await Promise.race([
        this.transport.request("shutdown", null),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);
      this.transport.notify("exit", null);
    } catch {
      // server didn't respond to shutdown
    }
    this.transport.close();
    this.process.kill();
    this.transport = null;
    this.process = null;
  }
}

function pathToUri(filePath: string): string {
  if (filePath.startsWith("file://")) return filePath;
  return `file://${filePath}`;
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) return uri.slice(7);
  return uri;
}
