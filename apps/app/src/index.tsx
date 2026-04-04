import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import "opentui-spinner/react";
import { startServer } from "@/server/server.ts";
import { initializeBuiltinTools } from "@/tool/registry.ts";
import { initializeAgents, applyAgentConfigOverrides } from "@/agent/agent.ts";
import { initializeMcpServers, shutdownMcpServers } from "@/mcp/index.ts";
import { initializeLsp, shutdownLsp } from "@/lsp/manager.ts";
import { startDaemonEventBridge, stopDaemonEventBridge } from "@/daemon/events.ts";
import { loadConfig } from "@/config/index.ts";
import { Session } from "@/session/index.ts";
import { App } from "@/tui/app.tsx";

function parseCliFlags(): { continueSession?: boolean; sessionId?: string; prompt?: string } {
  const args = process.argv.slice(2);
  let continueSession = false;
  let sessionId: string | undefined;
  const promptParts: string[] = [];

  for (const arg of args) {
    if (arg === "--continue" || arg === "-c") {
      continueSession = true;
    } else if (arg.startsWith("--session=")) {
      sessionId = arg.slice("--session=".length);
    } else if (arg.startsWith("-s=")) {
      sessionId = arg.slice("-s=".length);
    } else if (!arg.startsWith("-")) {
      promptParts.push(arg);
    }
  }

  return {
    continueSession: continueSession || undefined,
    sessionId,
    prompt: promptParts.length > 0 ? promptParts.join(" ") : undefined,
  };
}

function resolveInitialSession(flags: ReturnType<typeof parseCliFlags>): string | undefined {
  if (flags.sessionId) return flags.sessionId;

  if (flags.continueSession) {
    const sessions = Session.list();
    return sessions[0]?.id;
  }

  return undefined;
}

async function main(): Promise<void> {
  initializeBuiltinTools();
  initializeAgents();

  const config = loadConfig();
  if (Object.keys(config.agents).length > 0) {
    applyAgentConfigOverrides(config.agents);
  }

  const cliFlags = parseCliFlags();
  const initialSessionId = resolveInitialSession(cliFlags);

  if (initialSessionId) {
    process.env.KRAKEN_INITIAL_SESSION_ID = initialSessionId;
  }
  if (cliFlags.prompt) {
    process.env.KRAKEN_INITIAL_PROMPT = cliFlags.prompt;
  }

  const server = await startServer();
  process.env.KRAKEN_APP_PORT = new URL(server.url).port;

  startDaemonEventBridge();

  initializeMcpServers().catch((error) => {
    console.warn("[mcp] background init failed:", error);
  });

  initializeLsp(config.lsp);

  process.on("exit", () => {
    stopDaemonEventBridge();
    shutdownMcpServers().catch(() => {});
    shutdownLsp().catch(() => {});
  });

  const renderer = await createCliRenderer({
    targetFps: 60,
    exitOnCtrlC: false,
    autoFocus: true,
    gatherStats: false,
    openConsoleOnError: false,
  });

  createRoot(renderer).render(<App />);
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
