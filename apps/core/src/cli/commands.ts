import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { createSchedulerClient } from "@/clients/scheduler.ts";
import { createGatewayClient } from "@/clients/gateway.ts";
import { AgentDatabase } from "@/storage/database.ts";
import { loadConfiguration } from "@/configuration/loader.ts";
import { TaskQueueManager } from "@/queue/manager.ts";
import { SchedulerEventListener } from "@/scheduler/listener.ts";
import { synchronizeCronJobs, synchronizeWatchers } from "@/scheduler/synchronizer.ts";
import { WebhookEventListener } from "@/webhooks/listener.ts";
import { AgentExecutionLoop } from "@/agent/loop.ts";
import { TaskRunnerDaemon } from "@/agent/daemon.ts";
import { LanguageModelClient } from "@/language/client.ts";
import { createDefaultToolRegistry } from "@/tools/index.ts";
import { TimerManager } from "@/scheduling/timers.ts";
import { ApprovalPolicyResolver } from "@/approval/resolver.ts";

const KRAKEN_HOME = resolve(homedir(), ".kraken");
const CONFIGURATION_FILE_NAME = "kraken.yml";

function buildConfigurationTemplate(openrouterApiKey?: string): string {
  const apiKeyLine = openrouterApiKey ? `  apiKey: "${openrouterApiKey}"` : "  # apiKey: sk-or-...";

  return `# kraken agent configuration
# docs: https://github.com/kraken-agent/kraken

repo: "."

languageModel:
  provider: openrouter
  model: deepseek/deepseek-v3.2
${apiKeyLine}
  temperature: 0.7
  maxTokens: 16384

security:
  defaultPolicy: review_required
  rules:
    - trigger: manual
      policy: auto
    - trigger: cron
      policy: review_required
    - trigger: webhook
      policy: review_required
    - trigger: file_change
      policy: review_required
    - trigger: companion
      policy: review_required

git:
  branchPrefix: "kraken/"
  autoCommit: true
  commitPrefix: "kraken:"

services:
  schedulerUrl: "http://localhost:50051"
  gatewayUrl: "http://localhost:50052"

scheduler:
  crons: []
    # - name: daily-review
    #   expression: "0 9 * * *"
    #   task: review-open-prs

  watchers: []
    # - name: src-watcher
    #   paths: ["./src"]
    #   ignore: ["node_modules", ".git", "target", "dist"]
    #   debounceMs: 500

plugins: []
`;
}

async function promptForInput(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(question);
    return answer.trim();
  } finally {
    readline.close();
  }
}

const SERVICE_READINESS_MAX_ATTEMPTS = 15;
const SERVICE_READINESS_INTERVAL_MILLISECONDS = 2_000;

async function waitForServiceReadiness(
  serviceName: string,
  healthCheck: () => Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= SERVICE_READINESS_MAX_ATTEMPTS; attempt++) {
    try {
      const healthy = await healthCheck();
      if (healthy) {
        console.log(`  ${serviceName}: connected`);
        return true;
      }
    } catch {
      // service not ready yet
    }

    if (attempt < SERVICE_READINESS_MAX_ATTEMPTS) {
      if (attempt <= 3) {
        console.log(`  ${serviceName}: waiting... (attempt ${attempt})`);
      } else if (attempt % 3 === 0) {
        console.log(`  ${serviceName}: still waiting... (attempt ${attempt})`);
      }
      await Bun.sleep(SERVICE_READINESS_INTERVAL_MILLISECONDS);
    }
  }

  console.warn(`  ${serviceName}: unreachable after ${SERVICE_READINESS_MAX_ATTEMPTS} attempts`);
  return false;
}

export async function startCommand(): Promise<void> {
  const configuration = await loadConfiguration();

  console.log("starting kraken agent core...");
  console.log(`  scheduler: ${configuration.services.schedulerUrl}`);
  console.log(`  gateway:   ${configuration.services.gatewayUrl}`);
  console.log(`  database:  ${configuration.databasePath}`);
  console.log("");

  const database = new AgentDatabase(configuration.databasePath);
  const taskQueueManager = new TaskQueueManager(database);
  const schedulerClient = createSchedulerClient(configuration.services.schedulerUrl);
  const gatewayClient = createGatewayClient(configuration.services.gatewayUrl);

  console.log("waiting for services...");

  await waitForServiceReadiness("gateway", async () => {
    const response = await gatewayClient.healthCheck({});
    return response.healthy;
  });

  const schedulerReady = await waitForServiceReadiness("scheduler", async () => {
    await schedulerClient.listCrons({});
    return true;
  });

  if (schedulerReady && configuration.scheduler.crons.length > 0) {
    console.log("\nregistering cron jobs...");
    await synchronizeCronJobs(schedulerClient, configuration.scheduler);
  }

  if (schedulerReady && configuration.scheduler.watchers.length > 0) {
    console.log("\nregistering file watchers...");
    await synchronizeWatchers(schedulerClient, configuration.scheduler);
  }

  const approvalPolicyResolver = new ApprovalPolicyResolver(configuration.security);

  let schedulerEventListener: SchedulerEventListener | undefined;
  if (schedulerReady) {
    schedulerEventListener = new SchedulerEventListener(
      schedulerClient,
      taskQueueManager,
      approvalPolicyResolver,
    );
    schedulerEventListener.start();
  }

  const webhookEventListener = new WebhookEventListener(
    gatewayClient,
    taskQueueManager,
    approvalPolicyResolver,
  );
  webhookEventListener.start();

  const languageModelClient = new LanguageModelClient(
    configuration.services.gatewayUrl,
    configuration.languageModel,
  );
  const timerManager = new TimerManager(taskQueueManager);
  const toolRegistry = createDefaultToolRegistry({
    languageModelClient,
    schedulerClient,
    taskQueueManager,
    timerManager,
    database,
    commandPolicy: configuration.commands,
  });
  const executionLoop = new AgentExecutionLoop(
    languageModelClient,
    taskQueueManager,
    toolRegistry,
    database,
    { workingDirectory: configuration.repo },
  );

  const taskRunnerDaemon = new TaskRunnerDaemon(executionLoop, taskQueueManager);
  taskRunnerDaemon.start();

  taskQueueManager.addEventListener((event) => {
    console.log(`  task [${event.type}]: ${event.task.name} (${event.task.id.slice(0, 8)})`);
  });

  const taskCount = database.getTaskCount();
  console.log(`  database: ${taskCount} tasks stored`);
  console.log("\nagent core running. press ctrl+c to stop.");

  const shutdown = () => {
    console.log("\nshutting down...");
    taskRunnerDaemon.stop();
    schedulerEventListener?.stop();
    webhookEventListener.stop();
    database.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

export async function statusCommand(): Promise<void> {
  const configuration = await loadConfiguration();
  const gatewayClient = createGatewayClient(configuration.services.gatewayUrl);

  console.log("kraken agent status\n");

  try {
    const healthResponse = await gatewayClient.healthCheck({});
    console.log(
      `gateway:   ${healthResponse.healthy ? "healthy" : "unhealthy"} (v${healthResponse.version})`,
    );
    for (const [service, healthy] of Object.entries(healthResponse.services)) {
      console.log(`  ${service}: ${healthy ? "ok" : "off"}`);
    }
  } catch {
    console.log("gateway:   offline");
  }

  try {
    const schedulerClient = createSchedulerClient(configuration.services.schedulerUrl);
    const cronsResponse = await schedulerClient.listCrons({});
    console.log(`scheduler: online (${cronsResponse.crons.length} crons)`);
  } catch {
    console.log("scheduler: offline");
  }

  const database = new AgentDatabase(configuration.databasePath);
  const pending = database.getTaskCount("pending");
  const running = database.getTaskCount("running");
  const completed = database.getTaskCount("completed");
  const failed = database.getTaskCount("failed");
  console.log(
    `\ntasks: ${pending} pending, ${running} running, ${completed} completed, ${failed} failed`,
  );
  database.close();
}

export async function tasksCommand(): Promise<void> {
  const configuration = await loadConfiguration();
  const database = new AgentDatabase(configuration.databasePath);
  const tasks = database.listTasks({ limit: 20 });

  if (tasks.length === 0) {
    console.log("no tasks found.");
    database.close();
    return;
  }

  console.log("recent tasks:\n");
  for (const task of tasks) {
    const statusIcon =
      task.status === "completed"
        ? "✓"
        : task.status === "failed"
          ? "✗"
          : task.status === "running"
            ? "▶"
            : "○";
    const isAwaitingReview =
      task.approval_policy === "review_required" && task.status === "pending";
    const reviewTag = isAwaitingReview ? " [awaiting review]" : "";
    console.log(
      `  ${statusIcon} [${task.status}]${reviewTag} ${task.name} (${task.id.slice(0, 8)})`,
    );
    if (task.description) {
      console.log(`    ${task.description}`);
    }
  }

  database.close();
}

export async function reviewsCommand(): Promise<void> {
  const configuration = await loadConfiguration();
  const database = new AgentDatabase(configuration.databasePath);
  const taskQueueManager = new TaskQueueManager(database);
  const pendingReviews = taskQueueManager.listTasksAwaitingReview();

  if (pendingReviews.length === 0) {
    console.log("no tasks awaiting review.");
    database.close();
    return;
  }

  console.log(`${pendingReviews.length} task(s) awaiting review:\n`);
  for (const task of pendingReviews) {
    console.log(`  ◉ ${task.name} (${task.id.slice(0, 8)})`);
    console.log(`    trigger: ${task.triggerType} | priority: ${task.priority}`);
    if (task.description) {
      console.log(`    ${task.description}`);
    }
    console.log(`    created: ${task.createdAt.toISOString()}`);
    console.log(`    approve: kraken approve ${task.id.slice(0, 8)}`);
    console.log(`    reject:  kraken reject ${task.id.slice(0, 8)}`);
    console.log("");
  }

  database.close();
}

export async function approveCommand(taskIdPrefix: string): Promise<void> {
  if (!taskIdPrefix) {
    console.error("usage: kraken approve <task-id>");
    process.exit(1);
  }

  const configuration = await loadConfiguration();
  const database = new AgentDatabase(configuration.databasePath);
  const taskQueueManager = new TaskQueueManager(database);

  const matchingTask = findTaskByPrefix(taskQueueManager, taskIdPrefix);
  if (!matchingTask) {
    console.error(`no task found matching: ${taskIdPrefix}`);
    database.close();
    process.exit(1);
  }

  try {
    const approved = taskQueueManager.approveTask(matchingTask.id);
    console.log(`task approved: ${approved.name} (${approved.id.slice(0, 8)})`);
    console.log("the task will be picked up by the daemon on the next cycle.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed to approve task: ${message}`);
  }

  database.close();
}

export async function rejectCommand(taskIdPrefix: string, reason: string = ""): Promise<void> {
  if (!taskIdPrefix) {
    console.error("usage: kraken reject <task-id> [reason]");
    process.exit(1);
  }

  const configuration = await loadConfiguration();
  const database = new AgentDatabase(configuration.databasePath);
  const taskQueueManager = new TaskQueueManager(database);

  const matchingTask = findTaskByPrefix(taskQueueManager, taskIdPrefix);
  if (!matchingTask) {
    console.error(`no task found matching: ${taskIdPrefix}`);
    database.close();
    process.exit(1);
  }

  try {
    const rejected = taskQueueManager.rejectTask(matchingTask.id, reason);
    console.log(`task rejected: ${rejected.name} (${rejected.id.slice(0, 8)})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed to reject task: ${message}`);
  }

  database.close();
}

export async function initCommand(): Promise<void> {
  mkdirSync(KRAKEN_HOME, { recursive: true });
  const targetPath = join(KRAKEN_HOME, CONFIGURATION_FILE_NAME);
  const fileExists = await Bun.file(targetPath).exists();

  if (fileExists) {
    console.log(`${targetPath} already exists.`);
    process.exit(1);
  }

  console.log("kraken init\n");

  const openrouterApiKey = await promptForInput("openrouter api key (press enter to skip): ");

  const template = buildConfigurationTemplate(openrouterApiKey || undefined);
  await Bun.write(targetPath, template);

  console.log(`\ncreated ${targetPath}`);
  console.log("\nnext steps:");
  if (!openrouterApiKey) {
    console.log("  1. add your openrouter api key to ~/.kraken/kraken.yml or set OPENROUTER_API_KEY");
    console.log("  2. configure crons, watchers, and security rules as needed");
    console.log("  3. run: kraken start");
  } else {
    console.log("  1. configure crons, watchers, and security rules as needed");
    console.log("  2. run: kraken start");
  }
}

export async function runCommand(prompt: string): Promise<void> {
  if (!prompt) {
    console.error('usage: kraken run "your prompt here"');
    process.exit(1);
  }

  const configuration = await loadConfiguration();
  const { LanguageModelClient } = await import("@/language/client.ts");
  const { ConversationHistory } = await import("@/language/conversation.ts");
  const { buildSystemPrompt } = await import("@/agent/prompt.ts");
  const { toolsToNativeFormat } = await import("@/tools/schema.ts");

  const { AgentDatabase } = await import("@/storage/database.ts");
  const database = new AgentDatabase(configuration.databasePath);

  const languageModelClient = new LanguageModelClient(
    configuration.services.gatewayUrl,
    configuration.languageModel,
  );
  const toolRegistry = createDefaultToolRegistry({
    languageModelClient,
    database,
    commandPolicy: configuration.commands,
    profile: "cli",
  });
  const systemPrompt = buildSystemPrompt(toolRegistry.listTools());
  const conversation = new ConversationHistory(systemPrompt);

  languageModelClient.setNativeTools(toolsToNativeFormat(toolRegistry.listTools()));

  const toolContext = { workingDirectory: configuration.repo };

  console.log(`\n  prompt: ${prompt}\n`);

  try {
    let completionResult = await languageModelClient.completeConversation(conversation, prompt);
    let iterations = 0;

    while (iterations < 40) {
      iterations += 1;

      if (completionResult.finishReason !== "tool_calls" || completionResult.toolCalls.length === 0) {
        console.log(`  response:\n${completionResult.content}\n`);
        break;
      }

      for (const toolCall of completionResult.toolCalls) {
        console.log(`  ⚡ ${toolCall.function.name}`);

        let parameters: Record<string, unknown>;
        try {
          parameters = JSON.parse(toolCall.function.arguments);
        } catch {
          parameters = {};
        }

        const toolResult = await toolRegistry.executeTool(
          toolCall.function.name,
          parameters,
          toolContext,
        );

        const icon = toolResult.success ? "✓" : "✗";
        const preview =
          toolResult.output.length > 200
            ? toolResult.output.slice(0, 200) + "..."
            : toolResult.output;
        console.log(`    ${icon} ${preview}`);

        conversation.addToolResultMessage(
          toolCall.id,
          toolCall.function.name,
          toolResult.success ? toolResult.output : (toolResult.error ?? toolResult.output),
        );
      }

      const messages = conversation.getMessagesWithSystemPrompt();
      completionResult = await languageModelClient.complete(messages);

      if (completionResult.toolCalls.length > 0) {
        conversation.addAssistantToolCallMessage(completionResult.content, completionResult.toolCalls);
      } else {
        conversation.addAssistantMessage(completionResult.content);
      }
    }

    const usage = languageModelClient.getTokenUsage();
    console.log(
      `  tokens: ${usage.totalPromptTokens + usage.totalCompletionTokens} (${usage.requestCount} requests)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  error: ${message}`);
    process.exit(1);
  }
}

function findTaskByPrefix(
  taskQueueManager: TaskQueueManager,
  prefix: string,
): ReturnType<TaskQueueManager["getTask"]> {
  const allPending = taskQueueManager.listTasks({ status: "pending" as const });
  return allPending.find((task) => task.id.startsWith(prefix));
}
