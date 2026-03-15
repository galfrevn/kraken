import { createInterface } from "node:readline";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { DaemonService } from "@gen/agent/v1/daemon_pb.ts";
import { bold, colorize, fail } from "@/constants.ts";

const DEFAULT_DAEMON_GRPC_URL = "http://localhost:50051";
const TASK_POLL_INTERVAL_MILLISECONDS = 2000;

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

function writeToStderr(message: string): void {
  process.stderr.write(message);
}

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
    writeToStderr(`\n  Start it with: ${colorize("kraken daemon start", "cyan")}\n\n`);
    process.exit(1);
  }
}

async function submitTaskAndWaitForResult(
  daemonServiceClient: ReturnType<typeof createDaemonServiceClient>,
  promptText: string,
): Promise<number> {
  const submitResponse = await daemonServiceClient.submitTask({
    name: promptText.slice(0, 100),
    description: promptText,
    priority: 5,
  });

  const submittedTaskId = submitResponse.taskId;
  writeToStderr(`  ${colorize("Task submitted:", "dim")} ${submittedTaskId}\n`);

  let spinnerFrameIndex = 0;
  let lastPrintedStatusText = "";

  while (true) {
    const taskDetailResponse = await daemonServiceClient.getTaskDetail({
      taskId: submittedTaskId,
    });

    const currentTask = taskDetailResponse.task;
    if (!currentTask) {
      fail("Task disappeared from daemon.");
      return 1;
    }

    if (TERMINAL_TASK_STATUSES.has(currentTask.status)) {
      if (lastPrintedStatusText) {
        writeToStderr("\r\x1b[K");
      }

      if (currentTask.status === "completed") {
        writeToStderr(`  ${colorize("Task completed.", "green")}\n`);
      } else if (currentTask.status === "failed") {
        writeToStderr(`  ${colorize("Task failed.", "red")}\n`);
        if (currentTask.errorMessage) {
          writeToStderr(`  ${colorize("Error:", "red")} ${currentTask.errorMessage}\n`);
        }
      } else if (currentTask.status === "cancelled") {
        writeToStderr(`  ${colorize("Task cancelled.", "yellow")}\n`);
      }

      if (currentTask.output) {
        process.stdout.write(currentTask.output);
        if (!currentTask.output.endsWith("\n")) {
          process.stdout.write("\n");
        }
      }

      return currentTask.status === "completed" ? 0 : 1;
    }

    const currentSpinnerFrame = SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length];
    const statusDisplayText = `  ${currentSpinnerFrame} ${colorize(currentTask.status, "cyan")}...`;
    writeToStderr(`\r\x1b[K${statusDisplayText}`);
    lastPrintedStatusText = statusDisplayText;
    spinnerFrameIndex++;

    await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MILLISECONDS));
  }
}

async function readEntireStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function executeOneShot(promptText: string): Promise<void> {
  const daemonServiceClient = await verifyDaemonIsRunning();
  const exitCode = await submitTaskAndWaitForResult(daemonServiceClient, promptText);
  process.exit(exitCode);
}

async function executeInteractiveRepl(): Promise<void> {
  const daemonServiceClient = await verifyDaemonIsRunning();

  const readlineInterface = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${colorize("kraken", "cyan")}> `,
  });

  writeToStderr(`\n  ${bold("Kraken Chat")} ${colorize("(interactive mode)", "dim")}\n`);
  writeToStderr(`  Type a task and press Enter. Type ${colorize("exit", "cyan")} or press Ctrl+D to quit.\n\n`);

  readlineInterface.prompt();

  readlineInterface.on("line", async (inputLine: string) => {
    const trimmedInput = inputLine.trim();

    if (!trimmedInput) {
      readlineInterface.prompt();
      return;
    }

    if (trimmedInput === "exit" || trimmedInput === "quit") {
      writeToStderr("\n");
      readlineInterface.close();
      process.exit(0);
    }

    await submitTaskAndWaitForResult(daemonServiceClient, trimmedInput);
    writeToStderr("\n");
    readlineInterface.prompt();
  });

  readlineInterface.on("close", () => {
    writeToStderr("\n");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    writeToStderr("\n");
    readlineInterface.close();
    process.exit(0);
  });
}

export async function execute(args: string[]): Promise<void> {
  const promptFromArguments = args.join(" ").trim();

  if (promptFromArguments) {
    await executeOneShot(promptFromArguments);
  } else if (!process.stdin.isTTY) {
    const stdinContent = await readEntireStdin();
    if (!stdinContent) {
      fail("No input received from stdin.");
      process.exit(1);
    }
    await executeOneShot(stdinContent);
  } else {
    await executeInteractiveRepl();
  }
}
