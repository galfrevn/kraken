import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { AgentDatabase } from "@core/storage/database.ts";
import { loadConfiguration } from "@core/configuration/loader.ts";
import { LanguageModelClient } from "@core/language/client.ts";
import { createDefaultToolRegistry, createSessionCommandTool, createAskQuestionTool } from "@core/tools/index.ts";
import { McpToolRegistry } from "@core/mcp/registry.ts";
import { ProjectIndexer } from "@core/memory/indexer.ts";
import { ThreadManager } from "@/threads.ts";
import { createSessionExecutor } from "@/executor.ts";
import { Application } from "@/application.tsx";

export async function main(): Promise<void> {
  const configuration = await loadConfiguration();
  const database = new AgentDatabase(configuration.databasePath);

  const daemonUrl = process.env["KRAKEN_DAEMON_URL"] ?? configuration.services.schedulerUrl;
  let daemonConnected = false;
  try {
    const healthCheckResponse = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(2000) });
    daemonConnected = healthCheckResponse.ok;
  } catch {
    daemonConnected = false;
  }

  const languageModelClient = new LanguageModelClient(
    daemonConnected ? daemonUrl : configuration.services.llmProxyUrl,
    configuration.languageModel,
  );

  const mcpToolRegistry = new McpToolRegistry();
  if (configuration.mcpServers.length > 0) {
    const mcpConnectionResult = await mcpToolRegistry.connectToAllServers(configuration.mcpServers);
    if (mcpConnectionResult.connected.length > 0) {
      console.log(`[mcp] connected: ${mcpConnectionResult.connected.join(", ")}`);
    }
    for (const mcpFailure of mcpConnectionResult.failed) {
      console.error(`[mcp] "${mcpFailure.name}" failed: ${mcpFailure.error}`);
    }
  }

  const toolRegistry = createDefaultToolRegistry({
    languageModelClient,
    database,
    commandPolicy: configuration.commands,
    workingDirectory: configuration.repo,
    mcpTools: mcpToolRegistry.getTools(),
    profile: "chat",
  });

  const threadManager = new ThreadManager(languageModelClient, toolRegistry, configuration.repo, database);

  const sessionExecutor = createSessionExecutor(threadManager);
  toolRegistry.register(createSessionCommandTool(sessionExecutor));
  toolRegistry.register(
    createAskQuestionTool((pendingQuestions) => {
      pendingQuestions.resolve([]);
    }),
  );

  threadManager.initialize();

  const indexerFactCount = database.countFacts();
  if (indexerFactCount === 0) {
    const indexer = new ProjectIndexer(database);
    indexer.indexProject(configuration.repo).catch(() => {});
  }

  process.stdout.write("\x1B]0;Kraken\x07");

  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  const shutdown = async () => {
    process.stdout.write("\x1B]0;\x07");
    threadManager.saveNow();
    await mcpToolRegistry.disconnectAllServers();
    database.close();
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  createRoot(renderer).render(
    <Application
      threadManager={threadManager}
      languageModelClient={languageModelClient}
      daemonConnected={daemonConnected}
    />,
  );

  for (const delay of [50, 150, 300]) {
    setTimeout(() => { process.emit("SIGWINCH"); }, delay);
  }
}

if (import.meta.main) {
  main().catch((fatalError) => {
    console.error("fatal:", fatalError);
    process.exit(1);
  });
}
