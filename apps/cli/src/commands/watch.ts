import { existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { DaemonService } from "@gen/agent/v1/daemon_pb.ts";
import { bold, colorize, success, fail } from "@/constants.ts";

const DEFAULT_DAEMON_GRPC_URL = "http://localhost:50051";
const DEFAULT_WATCHED_PATHS = ["src/", "apps/", "lib/"];
const DEFAULT_DEBOUNCE_INTERVAL_MILLISECONDS = 2000;
const DEFAULT_TASK_TEMPLATE = "Review the recent changes in {{files}} and suggest improvements or fix obvious bugs";
const REVIEW_TASK_PRIORITY = 7;

const IGNORED_DIRECTORY_PATTERNS = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
  ".kraken-worktrees",
]);

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

function parseDebounceIntervalFromArguments(commandArguments: string[]): number {
  for (const argument of commandArguments) {
    if (argument.startsWith("--debounce=")) {
      const parsedDebounceValue = parseInt(argument.slice("--debounce=".length), 10);
      if (!Number.isNaN(parsedDebounceValue) && parsedDebounceValue > 0) {
        return parsedDebounceValue;
      }
    }
  }
  return DEFAULT_DEBOUNCE_INTERVAL_MILLISECONDS;
}

function parseTaskTemplateFromArguments(commandArguments: string[]): string {
  for (const argument of commandArguments) {
    if (argument.startsWith("--task-template=")) {
      const templateValue = argument.slice("--task-template=".length);
      if (templateValue.length > 0) {
        return templateValue;
      }
    }
  }
  return DEFAULT_TASK_TEMPLATE;
}

function parseWatchedPathsFromArguments(commandArguments: string[]): string[] {
  const positionalArguments = commandArguments.filter(
    (argument) => !argument.startsWith("--"),
  );
  if (positionalArguments.length > 0) {
    return positionalArguments;
  }
  return DEFAULT_WATCHED_PATHS;
}

function shouldIgnoreFilePath(filePath: string): boolean {
  const filePathSegments = filePath.split(/[/\\]/);
  return filePathSegments.some((segment) => IGNORED_DIRECTORY_PATTERNS.has(segment));
}

function buildTaskDescriptionFromTemplate(
  taskTemplate: string,
  changedFilePaths: Set<string>,
): string {
  const commaSeparatedFilePaths = Array.from(changedFilePaths).join(", ");
  return taskTemplate.replace("{{files}}", commaSeparatedFilePaths);
}

function printWatchBanner(
  resolvedWatchedPaths: string[],
  debounceIntervalMilliseconds: number,
): void {
  console.log(`\n  ${bold("Kraken Watch")} ${colorize("(companion mode)", "dim")}\n`);
  console.log(`  ${bold("Watching:")}`);
  for (const watchedPath of resolvedWatchedPaths) {
    console.log(`    ${colorize(watchedPath, "cyan")}`);
  }
  console.log(`\n  ${bold("Debounce:")} ${colorize(`${debounceIntervalMilliseconds}ms`, "cyan")}`);
  console.log(`\n  ${colorize("Press Ctrl+C to stop", "dim")}\n`);
}

export async function execute(commandArguments: string[]): Promise<void> {
  const daemonServiceClient = await verifyDaemonIsRunning();

  const debounceIntervalMilliseconds = parseDebounceIntervalFromArguments(commandArguments);
  const taskTemplate = parseTaskTemplateFromArguments(commandArguments);
  const requestedWatchPaths = parseWatchedPathsFromArguments(commandArguments);

  const currentWorkingDirectory = process.cwd();
  const resolvedAndExistingWatchPaths: string[] = [];

  for (const requestedPath of requestedWatchPaths) {
    const resolvedPath = resolve(currentWorkingDirectory, requestedPath);
    if (existsSync(resolvedPath)) {
      resolvedAndExistingWatchPaths.push(resolvedPath);
    } else {
      console.log(`  ${colorize("!", "yellow")} Skipping non-existent path: ${colorize(requestedPath, "dim")}`);
    }
  }

  if (resolvedAndExistingWatchPaths.length === 0) {
    fail("No valid paths to watch. Provide existing paths or ensure default paths exist.");
    process.exit(1);
  }

  printWatchBanner(resolvedAndExistingWatchPaths, debounceIntervalMilliseconds);

  const accumulatedChangedFilePaths = new Set<string>();
  let debounceTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const activeFileSystemWatchers: FSWatcher[] = [];

  async function submitAccumulatedChangesAsReviewTask(): Promise<void> {
    if (accumulatedChangedFilePaths.size === 0) return;

    const changedFilePathsSnapshot = new Set(accumulatedChangedFilePaths);
    const changedFileCount = changedFilePathsSnapshot.size;
    accumulatedChangedFilePaths.clear();

    const taskDescription = buildTaskDescriptionFromTemplate(taskTemplate, changedFilePathsSnapshot);

    try {
      const submitTaskResponse = await daemonServiceClient.submitTask({
        name: "Watch: review changes",
        description: taskDescription,
        priority: REVIEW_TASK_PRIORITY,
      });

      success(`Submitted review task: ${colorize(submitTaskResponse.taskId, "cyan")} (${changedFileCount} file${changedFileCount === 1 ? "" : "s"} changed)`);
    } catch (submissionError) {
      fail(`Failed to submit review task: ${submissionError instanceof Error ? submissionError.message : String(submissionError)}`);
    }
  }

  function handleFileChangeEvent(_eventType: string, changedFileName: string | null): void {
    if (!changedFileName) return;
    if (shouldIgnoreFilePath(changedFileName)) return;

    const relativeFilePath = changedFileName;
    accumulatedChangedFilePaths.add(relativeFilePath);
    console.log(`  ${colorize(relativeFilePath, "dim")}`);

    if (debounceTimeoutHandle !== null) {
      clearTimeout(debounceTimeoutHandle);
    }

    debounceTimeoutHandle = setTimeout(() => {
      debounceTimeoutHandle = null;
      submitAccumulatedChangesAsReviewTask();
    }, debounceIntervalMilliseconds);
  }

  for (const watchedDirectoryPath of resolvedAndExistingWatchPaths) {
    try {
      const fileSystemWatcher = watch(
        watchedDirectoryPath,
        { recursive: true },
        handleFileChangeEvent,
      );
      activeFileSystemWatchers.push(fileSystemWatcher);
    } catch (watchError) {
      console.log(`  ${colorize("!", "yellow")} Could not watch: ${colorize(watchedDirectoryPath, "dim")} (${watchError instanceof Error ? watchError.message : String(watchError)})`);
    }
  }

  function cleanupAndExit(): void {
    console.log(`\n  ${colorize("Stopping watchers...", "dim")}`);

    if (debounceTimeoutHandle !== null) {
      clearTimeout(debounceTimeoutHandle);
    }

    for (const fileSystemWatcher of activeFileSystemWatchers) {
      fileSystemWatcher.close();
    }

    console.log(`  ${colorize("Done.", "dim")}\n`);
    process.exit(0);
  }

  process.on("SIGINT", cleanupAndExit);
  process.on("SIGTERM", cleanupAndExit);
}
