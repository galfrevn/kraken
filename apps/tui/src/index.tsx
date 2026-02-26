import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { AgentDatabase } from "@core/storage/database.ts";
import { TaskQueueManager } from "@core/queue/manager.ts";
import { loadConfiguration } from "@core/configuration/loader.ts";
import { createSchedulerClient } from "@core/clients/scheduler.ts";
import { createGatewayClient } from "@core/clients/gateway.ts";
import { LanguageModelClient } from "@core/language/client.ts";
import { createDefaultToolRegistry, createSessionCommandTool, createPluginManagerTool } from "@core/tools/index.ts";
import { AgentExecutionLoop } from "@core/agent/loop.ts";
import { TaskRunnerDaemon } from "@core/agent/daemon.ts";
import { TimerManager } from "@core/scheduling/timers.ts";
import { ProjectIndexer } from "@core/memory/indexer.ts";
import { PluginRegistry, type PluginEntry } from "@core/plugins/index.ts";
import { TuiStore } from "@/store.ts";
import { ThreadManager } from "@/threads.ts";
import { createSessionExecutor } from "@/executor.ts";
import { registerPluginsCommand } from "@/commands.ts";
import { registerToolDisplayNames } from "@/views/chat.tsx";
import { Application } from "@/application.tsx";

function discoverPluginsInDirectory(pluginsDirectory: string): PluginEntry[] {
  if (!existsSync(pluginsDirectory)) return [];

  const discovered: PluginEntry[] = [];
  try {
    const entries = readdirSync(pluginsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginPath = resolve(pluginsDirectory, entry.name);
      const hasIndex = existsSync(join(pluginPath, "index.ts")) || existsSync(join(pluginPath, "index.js"));
      if (hasIndex) {
        discovered.push({ path: pluginPath, config: {} });
      }
    }
  } catch {
    /* directory not readable */
  }
  return discovered;
}

function discoverAllPlugins(): PluginEntry[] {
  const globalPluginsDirectory = join(homedir(), ".kraken", "plugins");
  return discoverPluginsInDirectory(globalPluginsDirectory);
}

function mergePluginEntries(configured: PluginEntry[], discovered: PluginEntry[], repoDirectory: string): PluginEntry[] {
  const configuredAbsolutePaths = new Set(
    configured.map((entry) => resolve(repoDirectory, entry.path)),
  );

  const merged = [...configured];
  for (const entry of discovered) {
    const absolutePath = resolve(repoDirectory, entry.path);
    if (!configuredAbsolutePaths.has(absolutePath)) {
      merged.push(entry);
    }
  }
  return merged;
}

export async function main(): Promise<void> {
  const configuration = await loadConfiguration();
  const database = new AgentDatabase(configuration.databasePath);
  const taskQueueManager = new TaskQueueManager(database);
  const schedulerClient = createSchedulerClient(configuration.services.schedulerUrl);
  const gatewayClient = createGatewayClient(configuration.services.gatewayUrl);

  const timerManager = new TimerManager(taskQueueManager);

  const store = new TuiStore(
    database,
    taskQueueManager,
    gatewayClient,
    schedulerClient,
    timerManager,
  );

  const pluginRegistry = new PluginRegistry();
  const basePluginContext = {
    workingDirectory: configuration.repo,
    databasePath: configuration.databasePath,
  };

  const discoveredPlugins = discoverAllPlugins();
  const allPluginEntries = mergePluginEntries(configuration.plugins, discoveredPlugins, configuration.repo);

  const pluginResult = await pluginRegistry.loadAll(
    allPluginEntries,
    configuration.repo,
    basePluginContext,
  );

  if (pluginResult.loaded.length > 0) {
    console.log(`[plugins] loaded: ${pluginResult.loaded.join(", ")}`);
  }
  for (const failure of pluginResult.failed) {
    console.error(`[plugins] failed to load "${failure.entry}": ${failure.error}`);
  }

  registerPluginsCommand(pluginRegistry);
  registerToolDisplayNames(pluginRegistry.getToolDisplayNames());

  const languageModelClient = new LanguageModelClient(
    configuration.services.gatewayUrl,
    configuration.languageModel,
  );
  const toolRegistry = createDefaultToolRegistry({
    languageModelClient,
    schedulerClient,
    taskQueueManager,
    timerManager,
    database,
    commandPolicy: configuration.commands,
    workingDirectory: configuration.repo,
    pluginTools: pluginRegistry.getTools(),
  });

  const executionLoop = new AgentExecutionLoop(
    languageModelClient,
    taskQueueManager,
    toolRegistry,
    database,
    { workingDirectory: configuration.repo },
  );

  const hookDispatcher = pluginRegistry.getHookDispatcher();
  executionLoop.setHookDispatcher(hookDispatcher);

  const daemon = new TaskRunnerDaemon(executionLoop, taskQueueManager, { silent: true });
  daemon.start();

  const threadManager = new ThreadManager(
    languageModelClient,
    toolRegistry,
    configuration.repo,
    database,
  );

  threadManager.setPluginPromptExtensions(() => pluginRegistry.getPromptExtensions());
  threadManager.setPluginHooks(hookDispatcher, { ...basePluginContext, config: {} });

  const sessionExecutor = createSessionExecutor(threadManager);
  toolRegistry.register(createSessionCommandTool(sessionExecutor));
  toolRegistry.register(createPluginManagerTool({
    pluginRegistry,
    toolRegistry,
    workingDirectory: configuration.repo,
    baseContext: basePluginContext,
    onToolDisplayNamesChanged: (names) => registerToolDisplayNames(names),
  }));

  threadManager.initialize();

  const indexerFactCount = database.countFacts();
  if (indexerFactCount === 0) {
    const indexer = new ProjectIndexer(database);
    indexer.indexProject(configuration.repo).catch(() => {});
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  });

  const shutdown = async () => {
    daemon.stop();
    timerManager.cancelAll();
    threadManager.saveNow();
    await pluginRegistry.shutdownAll();
    database.close();
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  createRoot(renderer).render(
    <Application
      store={store}
      threadManager={threadManager}
      pluginFailures={pluginResult.failed}
    />,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("fatal:", error);
    process.exit(1);
  });
}
