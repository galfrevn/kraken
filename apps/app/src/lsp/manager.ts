import { existsSync, readFileSync } from "fs";
import { extname, resolve } from "path";

import { Bus, Events } from "@/bus/index.ts";
import { LspClient } from "./client.ts";
import {
  DiagnosticSeverity,
  type Diagnostic,
  type LanguageServerConfig,
  type LspUserConfig,
} from "./types.ts";

const BUILTIN_SERVERS: Record<string, LanguageServerConfig> = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    languageId: (ext) => (ext.includes("ts") ? "typescriptreact" : "javascriptreact"),
  },
  rust: {
    command: ["rust-analyzer"],
    extensions: [".rs"],
    languageId: () => "rust",
  },
  python: {
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
    languageId: () => "python",
  },
  go: {
    command: ["gopls", "serve"],
    extensions: [".go"],
    languageId: () => "go",
  },
};

const SEVERITY_LABELS: Record<number, string> = {
  [DiagnosticSeverity.Error]: "error",
  [DiagnosticSeverity.Warning]: "warning",
  [DiagnosticSeverity.Information]: "info",
  [DiagnosticSeverity.Hint]: "hint",
};

let instance: LspManager | null = null;

class LspManager {
  private clients = new Map<string, LspClient>();
  private extensionToServer = new Map<string, string>();
  private serverConfigs = new Map<string, LanguageServerConfig>();
  private startingPromises = new Map<string, Promise<void>>();
  private unavailableServers = new Set<string>();
  private rootUri: string;

  constructor(rootUri: string) {
    this.rootUri = rootUri;
  }

  initialize(userConfig: Record<string, LspUserConfig> | false | undefined): void {
    if (userConfig === false) return;

    for (const [name, config] of Object.entries(BUILTIN_SERVERS)) {
      const userOverride = userConfig?.[name];
      if (userOverride?.enabled === false) continue;

      const merged: LanguageServerConfig = {
        command: userOverride?.command ?? config.command,
        extensions: userOverride?.extensions ?? config.extensions,
        languageId: config.languageId,
      };
      this.serverConfigs.set(name, merged);
      for (const ext of merged.extensions) {
        this.extensionToServer.set(ext, name);
      }
    }

    if (userConfig && typeof userConfig === "object") {
      for (const [name, userServerConfig] of Object.entries(userConfig)) {
        if (this.serverConfigs.has(name)) continue;
        if (userServerConfig.enabled === false) continue;
        if (!userServerConfig.command || !userServerConfig.extensions) continue;

        const config: LanguageServerConfig = {
          command: userServerConfig.command,
          extensions: userServerConfig.extensions,
          languageId: () => name,
        };
        this.serverConfigs.set(name, config);
        for (const ext of config.extensions) {
          this.extensionToServer.set(ext, name);
        }
      }
    }
  }

  private async ensureServerForFile(filePath: string): Promise<LspClient | null> {
    const ext = extname(filePath).toLowerCase();
    const serverName = this.extensionToServer.get(ext);
    if (!serverName) return null;
    if (this.unavailableServers.has(serverName)) return null;

    const existing = this.clients.get(serverName);
    if (existing?.isRunning) return existing;

    const startingPromise = this.startingPromises.get(serverName);
    if (startingPromise) {
      await startingPromise;
      return this.clients.get(serverName) ?? null;
    }

    const config = this.serverConfigs.get(serverName);
    if (!config) return null;

    const binaryPath = Bun.which(config.command[0]!);
    if (!binaryPath) {
      this.unavailableServers.add(serverName);
      return null;
    }

    const promise = (async () => {
      const client = new LspClient({
        serverName,
        command: config.command,
        rootUri: this.rootUri,
      });

      try {
        await client.start();
        this.clients.set(serverName, client);
        Bus.publish(Events.Lsp.ServerStarted, { serverName });
      } catch (error) {
        console.warn(`[lsp] failed to start ${serverName}: ${error}`);
        this.unavailableServers.add(serverName);
      }
    })();

    this.startingPromises.set(serverName, promise);
    try {
      await promise;
    } finally {
      this.startingPromises.delete(serverName);
    }

    return this.clients.get(serverName) ?? null;
  }

  getActiveServers(): string[] {
    return Array.from(this.clients.entries())
      .filter(([, client]) => client.isRunning)
      .map(([name]) => name);
  }

  async notifyFileChanged(filePath: string): Promise<void> {
    const absolutePath = resolve(filePath);
    const client = await this.ensureServerForFile(absolutePath);
    if (!client) return;

    if (!existsSync(absolutePath)) return;
    const content = readFileSync(absolutePath, "utf-8");

    const ext = extname(absolutePath).toLowerCase();
    const serverName = this.extensionToServer.get(ext);
    const config = serverName ? this.serverConfigs.get(serverName) : null;
    const languageId = config?.languageId(ext) ?? "plaintext";

    if (client.isFileOpen(absolutePath)) {
      await client.notifyDidChange(absolutePath, content);
    } else {
      await client.notifyDidOpen(absolutePath, languageId, content);
    }
  }

  async getDiagnosticsForFile(
    filePath: string,
    options?: { waitMs?: number },
  ): Promise<Diagnostic[]> {
    const absolutePath = resolve(filePath);
    const client = await this.ensureServerForFile(absolutePath);
    if (!client) return [];

    if (options?.waitMs) {
      return client.waitForDiagnostics(absolutePath, options.waitMs);
    }
    return client.getDiagnostics(absolutePath);
  }

  async shutdown(): Promise<void> {
    const shutdowns = Array.from(this.clients.values()).map((c) => c.shutdown());
    await Promise.allSettled(shutdowns);
    this.clients.clear();
  }
}

export function initializeLsp(userConfig: Record<string, LspUserConfig> | false | undefined): void {
  const rootUri = `file://${process.cwd()}`;
  instance = new LspManager(rootUri);
  instance.initialize(userConfig ?? {});
}

export function getLspManager(): LspManager | null {
  return instance;
}

export async function shutdownLsp(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}

export function formatDiagnostics(filePath: string, diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning,
  );
  if (errors.length === 0) return "";

  const lines = errors.map((d) => {
    const severity = SEVERITY_LABELS[d.severity ?? DiagnosticSeverity.Error] ?? "error";
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const source = d.source ? ` (${d.source})` : "";
    return `${filePath}:${line}:${col}: ${severity}: ${d.message}${source}`;
  });

  return `\n\n--- LSP Diagnostics ---\n${lines.join("\n")}`;
}
