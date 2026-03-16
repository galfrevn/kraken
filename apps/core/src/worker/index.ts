#!/usr/bin/env bun
/**
 * Worker subprocess entry point.
 *
 * Spawned by the Rust daemon as:
 *   bun run apps/core/src/worker/index.ts --task-id=xxx --daemon-url=http://localhost:50051
 *
 * Runs in isolation - one process per task. Has no API keys; all LLM access
 * goes through the daemon's WorkerService proxy.
 */

import { createDaemonWorkerClient, fetchTaskDetails } from "@/worker/daemon-client.ts";
import { runWorkerLoop, WORKER_EXIT_CODE } from "@/worker/worker-loop.ts";
import { createDefaultToolRegistry } from "@/tools/index.ts";
import { McpToolRegistry } from "@/mcp/registry.ts";
import { loadConfiguration } from "@/configuration/loader.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;

interface ParsedWorkerArguments {
  taskId: string;
  daemonUrl: string;
}

function parseWorkerArguments(): ParsedWorkerArguments {
  const rawArguments = process.argv.slice(2);
  let taskId: string | undefined;
  let daemonUrl: string | undefined;

  for (const argument of rawArguments) {
    if (argument.startsWith("--task-id=")) {
      taskId = argument.slice("--task-id=".length);
    } else if (argument.startsWith("--daemon-url=")) {
      daemonUrl = argument.slice("--daemon-url=".length);
    }
  }

  if (!taskId) {
    console.error("Missing required argument: --task-id");
    process.exit(WORKER_EXIT_CODE.BAD_INPUT);
  }

  if (!daemonUrl) {
    console.error("Missing required argument: --daemon-url");
    process.exit(WORKER_EXIT_CODE.BAD_INPUT);
  }

  return { taskId, daemonUrl };
}

async function main(): Promise<void> {
  const workerArguments = parseWorkerArguments();

  console.error(`[worker] Starting worker for task ${workerArguments.taskId}`);
  console.error(`[worker] Connecting to daemon at ${workerArguments.daemonUrl}`);

  // Create daemon client
  const daemonWorkerClient = createDaemonWorkerClient(workerArguments.daemonUrl);

  // Fetch task details from daemon
  let taskDetails;
  try {
    taskDetails = await fetchTaskDetails(daemonWorkerClient, workerArguments.taskId);
  } catch (fetchError) {
    const errorMessage =
      fetchError instanceof Error ? fetchError.message : String(fetchError);
    console.error(`[worker] Failed to fetch task details: ${errorMessage}`);
    process.exit(WORKER_EXIT_CODE.BAD_INPUT);
  }

  console.error(`[worker] Task loaded: "${taskDetails.name}" (attempt ${taskDetails.attempt})`);

  const workingDirectory = taskDetails.workingDirectory || process.cwd();

  const mcpToolRegistry = new McpToolRegistry();
  try {
    const workerConfiguration = await loadConfiguration();
    if (workerConfiguration.mcpServers.length > 0) {
      const mcpConnectionResult = await mcpToolRegistry.connectToAllServers(workerConfiguration.mcpServers);
      if (mcpConnectionResult.connected.length > 0) {
        console.error(`[worker] MCP servers connected: ${mcpConnectionResult.connected.join(", ")}`);
      }
      for (const mcpFailure of mcpConnectionResult.failed) {
        console.error(`[worker] MCP server "${mcpFailure.name}" failed: ${mcpFailure.error}`);
      }
    }
  } catch {
    console.error("[worker] Failed to load MCP configuration, continuing without MCP tools");
  }

  const toolRegistry = createDefaultToolRegistry({
    workingDirectory,
    profile: "daemon",
    mcpTools: mcpToolRegistry.getTools(),
  });

  // Start heartbeat interval
  const heartbeatInterval = setInterval(async () => {
    try {
      const memoryUsageBytes = process.memoryUsage().rss;
      await daemonWorkerClient.heartbeat({
        taskId: workerArguments.taskId,
        memoryBytes: BigInt(memoryUsageBytes),
      });
    } catch (heartbeatError) {
      console.error(
        `[worker] Heartbeat failed: ${heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError)}`,
      );
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Run the worker loop
  let workerResult;
  try {
    workerResult = await runWorkerLoop(
      daemonWorkerClient,
      taskDetails,
      toolRegistry,
      workingDirectory,
    );
  } catch (executionError) {
    clearInterval(heartbeatInterval);

    const errorMessage =
      executionError instanceof Error ? executionError.message : String(executionError);
    console.error(`[worker] Worker loop crashed: ${errorMessage}`);

    // Report the error result to the daemon
    try {
      await daemonWorkerClient.reportResult({
        taskId: workerArguments.taskId,
        exitCode: WORKER_EXIT_CODE.AGENT_ERROR,
        output: "",
        errorMessage,
        artifacts: [],
      });
    } catch (reportError) {
      console.error(
        `[worker] Failed to report error result: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    }

    process.exit(WORKER_EXIT_CODE.AGENT_ERROR);
  }

  // Stop heartbeat
  clearInterval(heartbeatInterval);

  // Report final result to daemon
  try {
    await daemonWorkerClient.reportResult({
      taskId: workerArguments.taskId,
      exitCode: workerResult.exitCode,
      output: workerResult.output,
      errorMessage: workerResult.errorMessage,
      artifacts: workerResult.artifacts.map((artifact) => ({
        type: artifact.type,
        url: artifact.url,
        name: artifact.name,
      })),
    });
  } catch (reportError) {
    console.error(
      `[worker] Failed to report result: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
    );
  }

  await mcpToolRegistry.disconnectAllServers();

  console.error(`[worker] Exiting with code ${workerResult.exitCode}`);
  process.exit(workerResult.exitCode);
}

main().catch((unhandledError) => {
  console.error(
    `[worker] Unhandled error: ${unhandledError instanceof Error ? unhandledError.message : String(unhandledError)}`,
  );
  process.exit(WORKER_EXIT_CODE.AGENT_ERROR);
});
