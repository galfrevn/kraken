import { spawn } from "bun";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { DaemonService } from "@gen/agent/v1/daemon_pb.ts";
import { KRAKEN_ROOT, bold, colorize, success, warn, fail } from "@/constants.ts";

const DAEMON_PID_FILE_PATH = join(homedir(), ".kraken", "daemon.pid");
const DEFAULT_DAEMON_GRPC_URL = "http://localhost:50051";

const DAEMON_BINARY_NAME = process.platform === "win32" ? "kraken-daemon.exe" : "kraken-daemon";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readDaemonPid(): number | null {
  try {
    if (!existsSync(DAEMON_PID_FILE_PATH)) return null;
    const pidFileContents = readFileSync(DAEMON_PID_FILE_PATH, "utf-8").trim();
    const parsedPid = parseInt(pidFileContents, 10);
    return Number.isNaN(parsedPid) ? null : parsedPid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(" ");
}

function cleanupStalePidFile(): void {
  try {
    if (existsSync(DAEMON_PID_FILE_PATH)) {
      unlinkSync(DAEMON_PID_FILE_PATH);
    }
  } catch {
    /* best-effort cleanup */
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ---------------------------------------------------------------------------
// Flags parsing
// ---------------------------------------------------------------------------

interface DaemonStartFlags {
  foreground: boolean;
  dev: boolean;
  configPath: string | null;
}

function parseDaemonStartFlags(args: string[]): DaemonStartFlags {
  let configPath: string | null = null;

  for (const arg of args) {
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    }
  }

  return {
    foreground: args.includes("--fg"),
    dev: args.includes("--dev"),
    configPath,
  };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function startDaemon(args: string[]): Promise<void> {
  const startFlags = parseDaemonStartFlags(args);

  const existingPid = readDaemonPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.log(`\n  Daemon is already running (PID ${existingPid}).`);
    console.log(`  Use ${colorize("kraken daemon restart", "cyan")} to restart it.\n`);
    return;
  }

  // Clean up stale PID file if the process is dead
  if (existingPid !== null) {
    cleanupStalePidFile();
  }

  const releaseBinaryPath = join(KRAKEN_ROOT, "apps", "daemon", "target", "release", DAEMON_BINARY_NAME);
  const debugBinaryPath = join(KRAKEN_ROOT, "apps", "daemon", "target", "debug", DAEMON_BINARY_NAME);
  const daemonDirectory = join(KRAKEN_ROOT, "apps", "daemon");

  let daemonCommand: string[];

  if (startFlags.dev) {
    if (existsSync(debugBinaryPath)) {
      daemonCommand = [debugBinaryPath];
    } else {
      daemonCommand = ["cargo", "run", "--quiet"];
    }
  } else {
    if (existsSync(releaseBinaryPath)) {
      daemonCommand = [releaseBinaryPath];
    } else if (existsSync(debugBinaryPath)) {
      daemonCommand = [debugBinaryPath];
    } else {
      daemonCommand = ["cargo", "run", "--quiet", "--release"];
    }
  }

  if (startFlags.configPath) {
    daemonCommand.push("--config", startFlags.configPath);
  }

  // Ensure ~/.kraken directory exists
  const krakenHomeDirectory = join(homedir(), ".kraken");
  if (!existsSync(krakenHomeDirectory)) {
    mkdirSync(krakenHomeDirectory, { recursive: true });
  }

  if (startFlags.foreground) {
    console.log(`\n  Starting daemon in foreground...`);
    console.log(`  ${colorize("Press Ctrl+C to stop.", "dim")}\n`);

    const foregroundProcess = spawn({
      cmd: daemonCommand,
      cwd: daemonDirectory,
      stdout: "inherit",
      stderr: "inherit",
    });

    process.on("SIGINT", () => {
      foregroundProcess.kill();
      cleanupStalePidFile();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      foregroundProcess.kill();
      cleanupStalePidFile();
      process.exit(0);
    });

    await foregroundProcess.exited;
    cleanupStalePidFile();
    return;
  }

  // Background mode: spawn detached
  console.log(`\n  Starting daemon in background...`);

  const backgroundProcess = spawn({
    cmd: daemonCommand,
    cwd: daemonDirectory,
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait a moment for the daemon to start and write its PID file
  await sleep(1500);

  const daemonPid = readDaemonPid();

  if (daemonPid !== null && isProcessAlive(daemonPid)) {
    success(`Daemon started (PID ${daemonPid})`);
    console.log(`  Use ${colorize("kraken daemon status", "cyan")} to check status.`);
    console.log(`  Use ${colorize("kraken daemon stop", "cyan")} to stop.\n`);
  } else if (backgroundProcess.pid && isProcessAlive(backgroundProcess.pid)) {
    // Daemon might not have written a PID file yet, but the process is alive
    writeFileSync(DAEMON_PID_FILE_PATH, String(backgroundProcess.pid), "utf-8");
    success(`Daemon started (PID ${backgroundProcess.pid})`);
    console.log(`  Use ${colorize("kraken daemon status", "cyan")} to check status.`);
    console.log(`  Use ${colorize("kraken daemon stop", "cyan")} to stop.\n`);
  } else {
    fail("Daemon failed to start. Check logs for details.");
    console.log(`  Try running with ${colorize("--fg", "cyan")} to see output:\n`);
    console.log(`    ${colorize("kraken daemon start --fg", "cyan")}\n`);
    process.exit(1);
  }
}

async function stopDaemon(): Promise<void> {
  const daemonPid = readDaemonPid();

  if (daemonPid === null) {
    console.log("\n  Daemon is not running (no PID file found).\n");
    return;
  }

  if (!isProcessAlive(daemonPid)) {
    console.log(`\n  Daemon is not running (PID ${daemonPid} is dead). Cleaning up PID file.`);
    cleanupStalePidFile();
    console.log();
    return;
  }

  console.log(`\n  Stopping daemon (PID ${daemonPid})...`);

  try {
    process.kill(daemonPid, "SIGTERM");
  } catch {
    fail(`Failed to send termination signal to PID ${daemonPid}.`);
    console.log();
    return;
  }

  // Poll for up to 30 seconds waiting for the process to exit
  const maximumWaitTimeMilliseconds = 30_000;
  const pollIntervalMilliseconds = 500;
  let elapsedMilliseconds = 0;

  while (elapsedMilliseconds < maximumWaitTimeMilliseconds) {
    await sleep(pollIntervalMilliseconds);
    elapsedMilliseconds += pollIntervalMilliseconds;

    if (!isProcessAlive(daemonPid)) {
      cleanupStalePidFile();
      success("Daemon stopped.");
      console.log();
      return;
    }
  }

  warn(`Daemon did not stop within ${maximumWaitTimeMilliseconds / 1000} seconds (PID ${daemonPid}).`);
  console.log(`  You may need to kill it manually: ${colorize(`kill -9 ${daemonPid}`, "cyan")}\n`);
}

async function showDaemonStatus(): Promise<void> {
  const daemonPid = readDaemonPid();

  if (daemonPid === null || !isProcessAlive(daemonPid)) {
    if (daemonPid !== null) {
      cleanupStalePidFile();
    }
    console.log(`\n  ${bold("Daemon status:")} ${colorize("not running", "red")}\n`);
    return;
  }

  console.log(`\n  ${bold("Daemon status:")} ${colorize("running", "green")}`);
  console.log(`  ${bold("PID:")} ${daemonPid}`);

  // Try to connect via gRPC and fetch detailed status
  try {
    const daemonGrpcUrl = process.env.KRAKEN_SCHEDULER_URL || DEFAULT_DAEMON_GRPC_URL;
    const grpcTransport = createGrpcTransport({ baseUrl: daemonGrpcUrl });
    const daemonServiceClient = createClient(DaemonService, grpcTransport);

    const statusResponse = await daemonServiceClient.getStatus({});

    const uptimeDisplay = formatUptime(Number(statusResponse.uptimeSeconds));
    const healthIndicator = statusResponse.healthy
      ? colorize("healthy", "green")
      : colorize("unhealthy", "red");
    const gatewayIndicator = statusResponse.gatewayConnected
      ? colorize("connected", "green")
      : colorize("disconnected", "yellow");

    console.log(`  ${bold("Health:")} ${healthIndicator}`);
    console.log(`  ${bold("Uptime:")} ${uptimeDisplay}`);
    console.log(`  ${bold("Workers:")} ${statusResponse.activeWorkers}/${statusResponse.maxWorkers} active`);
    console.log(`  ${bold("Pending tasks:")} ${statusResponse.pendingTasks}`);
    console.log(`  ${bold("Completed today:")} ${statusResponse.completedTasksToday}`);
    console.log(`  ${bold("Gateway:")} ${gatewayIndicator}`);
  } catch {
    warn("Could not connect to daemon gRPC -- the daemon may still be starting up.");
  }

  console.log();
}

async function restartDaemon(args: string[]): Promise<void> {
  const daemonPid = readDaemonPid();

  if (daemonPid !== null && isProcessAlive(daemonPid)) {
    await stopDaemon();
  }

  await startDaemon(args);
}

async function reloadDaemonConfiguration(): Promise<void> {
  if (process.platform === "win32") {
    warn("Configuration reload via signal is not supported on Windows.");
    console.log("  Restart the daemon instead:");
    console.log(`    ${colorize("kraken daemon restart", "cyan")}\n`);
    return;
  }

  const daemonPid = readDaemonPid();

  if (daemonPid === null || !isProcessAlive(daemonPid)) {
    if (daemonPid !== null) {
      cleanupStalePidFile();
    }
    console.log("\n  Daemon is not running.\n");
    return;
  }

  try {
    process.kill(daemonPid, "SIGHUP");
    success(`Sent SIGHUP to daemon (PID ${daemonPid}). Configuration will be reloaded.`);
    console.log();
  } catch {
    fail(`Failed to send SIGHUP to PID ${daemonPid}.`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printDaemonUsage(): void {
  console.log(`\n  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken daemon", "cyan")} ${colorize("<subcommand> [options]", "dim")}\n`);
  console.log(`  ${bold("Subcommands:")}\n`);
  console.log(`    ${colorize("start", "cyan")}     Start the daemon`);
  console.log(`    ${colorize("stop", "cyan")}      Stop the daemon`);
  console.log(`    ${colorize("status", "cyan")}    Show daemon status`);
  console.log(`    ${colorize("restart", "cyan")}   Stop and restart the daemon`);
  console.log(`    ${colorize("reload", "cyan")}    Reload configuration (SIGHUP)`);
  console.log(`\n  ${bold("Start options:")}\n`);
  console.log(`    ${colorize("--fg", "cyan")}            Run in foreground (inherit stdout/stderr)`);
  console.log(`    ${colorize("--dev", "cyan")}           Use debug binary instead of release`);
  console.log(`    ${colorize("--config=PATH", "cyan")}   Pass config file path to daemon\n`);
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  const remainingArgs = subcommand ? args.filter((arg) => arg !== subcommand) : args;

  switch (subcommand) {
    case "start":
      await startDaemon(remainingArgs);
      break;
    case "stop":
      await stopDaemon();
      break;
    case "status":
      await showDaemonStatus();
      break;
    case "restart":
      await restartDaemon(remainingArgs);
      break;
    case "reload":
      await reloadDaemonConfiguration();
      break;
    default:
      if (subcommand) {
        fail(`Unknown daemon subcommand: '${subcommand}'`);
      }
      printDaemonUsage();
      break;
  }
}
