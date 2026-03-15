import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { DaemonService } from "@gen/agent/v1/daemon_pb.ts";
import { bold, colorize, fail, warn } from "@/constants.ts";

const DEFAULT_DAEMON_GRPC_URL = "http://localhost:50051";

function createDaemonServiceClient() {
  const daemonGrpcUrl = process.env.KRAKEN_SCHEDULER_URL || DEFAULT_DAEMON_GRPC_URL;
  const grpcTransport = createGrpcTransport({ baseUrl: daemonGrpcUrl });
  return createClient(DaemonService, grpcTransport);
}

async function verifyDaemonIsRunning(): Promise<ReturnType<typeof createDaemonServiceClient>> {
  const daemonServiceClient = createDaemonServiceClient();

  try {
    await daemonServiceClient.getStatus({});
    return daemonServiceClient;
  } catch {
    fail("Cannot connect to kraken daemon. Is it running?");
    console.error(`\n  Start it with: ${colorize("kraken daemon start", "cyan")}\n`);
    process.exit(1);
  }
}

function formatCostAsUsd(costValueUsd: number): string {
  return `$${costValueUsd.toFixed(4)}`;
}

function formatTokenCountWithCommas(tokenCount: bigint): string {
  return Number(tokenCount).toLocaleString("en-US");
}

async function costSummary(): Promise<void> {
  const daemonServiceClient = await verifyDaemonIsRunning();

  const costSummaryResponse = await daemonServiceClient.getCostSummary({});

  const totalCostTodayUsd = costSummaryResponse.totalCostTodayUsd;
  const totalCostWeekUsd = costSummaryResponse.totalCostWeekUsd;
  const totalCostMonthUsd = costSummaryResponse.totalCostMonthUsd;
  const totalPromptTokensToday = costSummaryResponse.totalPromptTokensToday;
  const totalCompletionTokensToday = costSummaryResponse.totalCompletionTokensToday;
  const totalTasksToday = costSummaryResponse.totalTasksToday;
  const costWarningThresholdUsd = costSummaryResponse.costWarningThresholdUsd;

  console.log(`\n  ${bold("Cost Summary")}\n`);

  const formattedPromptTokens = formatTokenCountWithCommas(totalPromptTokensToday);
  const formattedCompletionTokens = formatTokenCountWithCommas(totalCompletionTokensToday);

  console.log(
    `  Today:           ${colorize(formatCostAsUsd(totalCostTodayUsd), "cyan")}  (${totalTasksToday} tasks, ${formattedPromptTokens} prompt tokens, ${formattedCompletionTokens} completion tokens)`,
  );
  console.log(`  This week:       ${colorize(formatCostAsUsd(totalCostWeekUsd), "cyan")}`);
  console.log(`  This month:      ${colorize(formatCostAsUsd(totalCostMonthUsd), "cyan")}`);
  console.log();
  console.log(`  Warning threshold: ${colorize(formatCostAsUsd(costWarningThresholdUsd), "yellow")}`);

  if (totalCostTodayUsd > costWarningThresholdUsd) {
    console.log();
    warn(
      `Today's cost (${formatCostAsUsd(totalCostTodayUsd)}) exceeds the warning threshold (${formatCostAsUsd(costWarningThresholdUsd)})!`,
    );
  }

  console.log();
}

async function costTasks(): Promise<void> {
  const daemonServiceClient = await verifyDaemonIsRunning();

  const listTasksResponse = await daemonServiceClient.listTasks({ statusFilter: "", limit: 20 });
  const recentTasks = listTasksResponse.tasks;

  if (recentTasks.length === 0) {
    console.log(`\n  No tasks found.\n`);
    return;
  }

  console.log(`\n  ${bold("Task Costs")} ${colorize(`(${recentTasks.length} tasks)`, "dim")}\n`);

  const columnNameWidth = 40;
  const columnCostWidth = 12;
  const columnPromptTokensWidth = 16;

  const headerLine = `  ${"Name".padEnd(columnNameWidth)} ${"Cost".padEnd(columnCostWidth)} ${"Prompt Tokens".padEnd(columnPromptTokensWidth)} ${"Completion Tokens"}`;
  console.log(colorize(headerLine, "dim"));
  console.log(colorize("  " + "-".repeat(headerLine.length - 2), "dim"));

  let runningTotalCostUsd = 0;

  for (const task of recentTasks) {
    const truncatedTaskName =
      task.name.length > columnNameWidth ? task.name.slice(0, columnNameWidth - 3) + "..." : task.name;
    const formattedTaskCost = formatCostAsUsd(task.estimatedCostUsd);
    const formattedPromptTokens = formatTokenCountWithCommas(task.promptTokens);
    const formattedCompletionTokens = formatTokenCountWithCommas(task.completionTokens);

    runningTotalCostUsd += task.estimatedCostUsd;

    console.log(
      `  ${truncatedTaskName.padEnd(columnNameWidth)} ${colorize(formattedTaskCost, "cyan").padEnd(columnCostWidth + 9)} ${formattedPromptTokens.padEnd(columnPromptTokensWidth)} ${formattedCompletionTokens}`,
    );
  }

  console.log(colorize("  " + "-".repeat(headerLine.length - 2), "dim"));
  console.log(`  ${"Total".padEnd(columnNameWidth)} ${colorize(formatCostAsUsd(runningTotalCostUsd), "green")}`);
  console.log();
}

function printCostUsage(): void {
  console.log(`\n  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken cost", "cyan")} ${colorize("[subcommand]", "dim")}\n`);
  console.log(`  ${bold("Subcommands:")}\n`);
  console.log(`    ${colorize("summary", "cyan")}                      Show cost summary for today, this week, and this month`);
  console.log(`    ${colorize("tasks", "cyan")}                        Show per-task cost breakdown (last 20 tasks)\n`);
  console.log(`  Running ${colorize("kraken cost", "cyan")} without a subcommand shows the summary.\n`);
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args.find((argument) => !argument.startsWith("-"));

  switch (subcommand) {
    case "summary":
    case undefined:
      await costSummary();
      break;
    case "tasks":
      await costTasks();
      break;
    default:
      if (subcommand) {
        fail(`Unknown cost subcommand: '${subcommand}'`);
      }
      printCostUsage();
      break;
  }
}
