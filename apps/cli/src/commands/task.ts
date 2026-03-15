import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { DaemonService } from "@gen/agent/v1/daemon_pb.ts";
import { bold, colorize, success, warn, fail } from "@/constants.ts";

const DEFAULT_DAEMON_GRPC_URL = "http://localhost:50051";
const WORKTREES_DIRECTORY_NAME = ".kraken-worktrees";
const WORKTREE_PREFIX = "kraken-task-";
const DEFAULT_OLDER_THAN_DAYS = 7;
const MILLISECONDS_PER_DAY = 86_400_000;

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

function formatTimestamp(timestamp: { seconds: bigint } | undefined): string {
  if (!timestamp) return colorize("--", "dim");
  const dateObject = new Date(Number(timestamp.seconds) * 1000);
  return dateObject.toLocaleString();
}

function colorizeTaskStatus(status: string): string {
  switch (status) {
    case "completed":
      return colorize(status, "green");
    case "failed":
      return colorize(status, "red");
    case "cancelled":
      return colorize(status, "yellow");
    case "running":
      return colorize(status, "cyan");
    case "pending":
      return colorize(status, "dim");
    default:
      return status;
  }
}

function parseDaysFromDurationString(durationString: string): number {
  const durationMatch = durationString.match(/^(\d+)d$/);
  if (!durationMatch) {
    fail(`Invalid duration format: '${durationString}'. Use format like '3d', '7d', '1d'.`);
    process.exit(1);
  }
  return parseInt(durationMatch[1]!, 10);
}

function formatBytesAsHumanReadable(totalBytes: number): string {
  if (totalBytes < 1024) return `${totalBytes} B`;
  if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
  if (totalBytes < 1024 * 1024 * 1024) return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function calculateDirectorySizeRecursively(directoryPath: string): number {
  let totalSizeBytes = 0;

  try {
    const directoryEntries = readdirSync(directoryPath, { withFileTypes: true });
    for (const entry of directoryEntries) {
      const entryFullPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        totalSizeBytes += calculateDirectorySizeRecursively(entryFullPath);
      } else {
        try {
          totalSizeBytes += statSync(entryFullPath).size;
        } catch {
          /* skip inaccessible files */
        }
      }
    }
  } catch {
    /* skip inaccessible directories */
  }

  return totalSizeBytes;
}

function findGitRepositoryRoot(): string {
  try {
    const repositoryRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return repositoryRoot;
  } catch {
    return process.cwd();
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function taskList(): Promise<void> {
  const daemonServiceClient = await verifyDaemonIsRunning();

  const listTasksResponse = await daemonServiceClient.listTasks({ statusFilter: "", limit: 50 });
  const allTasks = listTasksResponse.tasks;

  if (allTasks.length === 0) {
    console.log(`\n  No tasks found.\n`);
    return;
  }

  console.log(`\n  ${bold("Tasks")} ${colorize(`(${allTasks.length} total)`, "dim")}\n`);

  const columnIdWidth = 8;
  const columnStatusWidth = 12;
  const columnPriorityWidth = 4;
  const columnNameWidth = 40;

  const headerLine = `  ${"ID".padEnd(columnIdWidth)} ${"Status".padEnd(columnStatusWidth)} ${"Pri".padEnd(columnPriorityWidth)} ${"Name".padEnd(columnNameWidth)} ${"Created"}`;
  console.log(colorize(headerLine, "dim"));
  console.log(colorize("  " + "-".repeat(headerLine.length - 2), "dim"));

  for (const task of allTasks) {
    const truncatedTaskId = task.id.length > columnIdWidth ? task.id.slice(0, columnIdWidth) : task.id;
    const truncatedTaskName =
      task.name.length > columnNameWidth ? task.name.slice(0, columnNameWidth - 3) + "..." : task.name;
    const formattedCreatedAt = formatTimestamp(task.createdAt);

    console.log(
      `  ${truncatedTaskId.padEnd(columnIdWidth)} ${colorizeTaskStatus(task.status).padEnd(columnStatusWidth + 9)} ${String(task.priority).padEnd(columnPriorityWidth)} ${truncatedTaskName.padEnd(columnNameWidth)} ${formattedCreatedAt}`,
    );
  }

  console.log();

  const taskCountsByStatus = new Map<string, number>();
  for (const task of allTasks) {
    taskCountsByStatus.set(task.status, (taskCountsByStatus.get(task.status) ?? 0) + 1);
  }

  const statusSummaryParts: string[] = [];
  for (const [status, count] of taskCountsByStatus) {
    statusSummaryParts.push(`${colorizeTaskStatus(status)}: ${count}`);
  }

  console.log(`  ${statusSummaryParts.join("  |  ")}\n`);
}

async function taskSubmit(args: string[]): Promise<void> {
  const promptText = args.filter((argument) => !argument.startsWith("--")).join(" ").trim();

  if (!promptText) {
    fail("Missing task prompt. Usage: kraken task submit \"your task description\"");
    process.exit(1);
  }

  let taskPriority = 5;
  for (const argument of args) {
    if (argument.startsWith("--priority=")) {
      const parsedPriorityValue = parseInt(argument.slice("--priority=".length), 10);
      if (!Number.isNaN(parsedPriorityValue) && parsedPriorityValue >= 1 && parsedPriorityValue <= 10) {
        taskPriority = parsedPriorityValue;
      }
    }
  }

  const daemonServiceClient = await verifyDaemonIsRunning();

  const submitResponse = await daemonServiceClient.submitTask({
    name: promptText.slice(0, 100),
    description: promptText,
    priority: taskPriority,
  });

  success(`Task submitted: ${colorize(submitResponse.taskId, "cyan")}`);
  console.log(`  Priority: ${taskPriority}`);
  console.log(`\n  Track with: ${colorize(`kraken task list`, "cyan")}\n`);
}

async function taskCancel(taskId: string | undefined): Promise<void> {
  if (!taskId) {
    fail("Missing task ID. Usage: kraken task cancel <task-id>");
    process.exit(1);
  }

  const daemonServiceClient = await verifyDaemonIsRunning();

  const cancelResponse = await daemonServiceClient.cancelTask({ taskId });

  if (cancelResponse.success) {
    success(`Task ${colorize(taskId, "cyan")} cancelled.`);
  } else {
    fail(`Failed to cancel task ${taskId}. It may have already completed or does not exist.`);
  }
  console.log();
}

async function taskCleanup(args: string[]): Promise<void> {
  let olderThanDays = DEFAULT_OLDER_THAN_DAYS;

  for (const argument of args) {
    if (argument.startsWith("--older-than=")) {
      const durationValue = argument.slice("--older-than=".length);
      olderThanDays = parseDaysFromDurationString(durationValue);
    } else if (argument === "--older-than") {
      const nextArgumentIndex = args.indexOf(argument) + 1;
      if (nextArgumentIndex < args.length) {
        olderThanDays = parseDaysFromDurationString(args[nextArgumentIndex]!);
      }
    }
  }

  const repositoryRoot = findGitRepositoryRoot();
  const worktreesDirectoryPath = join(repositoryRoot, WORKTREES_DIRECTORY_NAME);

  if (!existsSync(worktreesDirectoryPath)) {
    console.log(`\n  No worktrees found (${colorize(worktreesDirectoryPath, "dim")} does not exist).\n`);
    return;
  }

  let worktreeDirectoryEntries: string[];
  try {
    worktreeDirectoryEntries = readdirSync(worktreesDirectoryPath).filter((entryName) =>
      entryName.startsWith(WORKTREE_PREFIX),
    );
  } catch {
    fail(`Could not read worktrees directory: ${worktreesDirectoryPath}`);
    process.exit(1);
  }

  if (worktreeDirectoryEntries.length === 0) {
    console.log(`\n  No ${colorize("kraken-task-*", "cyan")} worktrees found.\n`);
    return;
  }

  const ageThresholdTimestamp = Date.now() - olderThanDays * MILLISECONDS_PER_DAY;
  const worktreesToRemove: Array<{ directoryName: string; fullPath: string; sizeBytes: number }> = [];

  for (const worktreeDirectoryName of worktreeDirectoryEntries) {
    const worktreeFullPath = join(worktreesDirectoryPath, worktreeDirectoryName);

    try {
      const worktreeStats = statSync(worktreeFullPath);
      if (!worktreeStats.isDirectory()) continue;

      if (worktreeStats.mtimeMs < ageThresholdTimestamp) {
        const directorySizeBytes = calculateDirectorySizeRecursively(worktreeFullPath);
        worktreesToRemove.push({
          directoryName: worktreeDirectoryName,
          fullPath: worktreeFullPath,
          sizeBytes: directorySizeBytes,
        });
      }
    } catch {
      /* skip inaccessible worktree directories */
    }
  }

  if (worktreesToRemove.length === 0) {
    console.log(
      `\n  No worktrees older than ${olderThanDays}d found (${worktreeDirectoryEntries.length} exist, all are recent).\n`,
    );
    return;
  }

  console.log(
    `\n  ${bold("Cleaning up worktrees")} older than ${colorize(`${olderThanDays}d`, "cyan")}...\n`,
  );

  let totalRemovedCount = 0;
  let totalFreedBytes = 0;
  let totalFailedCount = 0;

  for (const worktreeEntry of worktreesToRemove) {
    try {
      try {
        execSync(`git worktree remove --force "${worktreeEntry.fullPath}"`, {
          cwd: repositoryRoot,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        rmSync(worktreeEntry.fullPath, { recursive: true, force: true });
      }

      totalRemovedCount++;
      totalFreedBytes += worktreeEntry.sizeBytes;
      console.log(
        `    ${colorize("removed", "green")} ${worktreeEntry.directoryName} (${formatBytesAsHumanReadable(worktreeEntry.sizeBytes)})`,
      );
    } catch {
      totalFailedCount++;
      console.log(`    ${colorize("failed", "red")}  ${worktreeEntry.directoryName}`);
    }
  }

  try {
    execSync("git worktree prune", {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    warn("Could not run 'git worktree prune'.");
  }

  console.log();
  success(`Removed ${totalRemovedCount} worktree${totalRemovedCount === 1 ? "" : "s"}, freed ${formatBytesAsHumanReadable(totalFreedBytes)}.`);

  if (totalFailedCount > 0) {
    warn(`${totalFailedCount} worktree${totalFailedCount === 1 ? "" : "s"} could not be removed.`);
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printTaskUsage(): void {
  console.log(`\n  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken task", "cyan")} ${colorize("<subcommand> [options]", "dim")}\n`);
  console.log(`  ${bold("Subcommands:")}\n`);
  console.log(`    ${colorize("list", "cyan")}                        List all tasks from the daemon`);
  console.log(`    ${colorize("submit", "cyan")} ${colorize('"prompt"', "dim")}               Submit a new task`);
  console.log(`    ${colorize("cancel", "cyan")} ${colorize("<id>", "dim")}                   Cancel a running task`);
  console.log(`    ${colorize("cleanup", "cyan")}                      Remove old worktrees`);
  console.log(`\n  ${bold("Submit options:")}\n`);
  console.log(`    ${colorize("--priority=N", "cyan")}                 Task priority 1-10 (default: 5)`);
  console.log(`\n  ${bold("Cleanup options:")}\n`);
  console.log(`    ${colorize("--older-than=Nd", "cyan")}              Remove worktrees older than N days (default: 7d)\n`);
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args.find((argument) => !argument.startsWith("-"));
  const remainingArgs = subcommand ? args.filter((argument) => argument !== subcommand) : args;

  switch (subcommand) {
    case "list":
      await taskList();
      break;
    case "submit":
      await taskSubmit(remainingArgs);
      break;
    case "cancel": {
      const taskIdArgument = remainingArgs.find((argument) => !argument.startsWith("-"));
      await taskCancel(taskIdArgument);
      break;
    }
    case "cleanup":
      await taskCleanup(remainingArgs);
      break;
    default:
      if (subcommand) {
        fail(`Unknown task subcommand: '${subcommand}'`);
      }
      printTaskUsage();
      break;
  }
}
