import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { DaemonService } from "@gen/agent/v1/daemon_pb.ts";
import { KRAKEN_ROOT, KRAKEN_HOME, VERSION, step, bold, colorize } from "@/constants.ts";

interface CheckResult {
  label: string;
  status: "ok" | "warn" | "fail";
  message: string;
  indented?: boolean;
}

const STATUS_ICONS = {
  ok: colorize("\u2713", "green"),
  warn: colorize("\u26A0", "yellow"),
  fail: colorize("\u2717", "red"),
} as const;

const DAEMON_PID_FILE_PATH = join(homedir(), ".kraken", "daemon.pid");
const DEFAULT_DAEMON_GRPC_URL = "http://localhost:50051";

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function checkCommandAvailability(
  command: string,
  args: string[],
): { available: boolean; version: string } {
  try {
    const spawnResult = Bun.spawnSync({ cmd: [command, ...args], stdout: "pipe", stderr: "pipe" });
    if (spawnResult.exitCode === 0) {
      return {
        available: true,
        version: spawnResult.stdout.toString().trim().split("\n")[0] || "unknown",
      };
    }
    return { available: false, version: "" };
  } catch {
    return { available: false, version: "" };
  }
}

function readDaemonPidFromFile(): number | null {
  try {
    if (!existsSync(DAEMON_PID_FILE_PATH)) return null;
    const pidFileContents = readFileSync(DAEMON_PID_FILE_PATH, "utf-8").trim();
    const parsedPid = parseInt(pidFileContents, 10);
    return Number.isNaN(parsedPid) ? null : parsedPid;
  } catch {
    return null;
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function formatUptimeDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(" ");
}

function formatBytesAsHumanReadable(totalBytes: number): string {
  if (totalBytes < 1024) return `${totalBytes} B`;
  if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
  if (totalBytes < 1024 * 1024 * 1024) return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function calculateDirectoryDiskUsage(directoryPath: string): number {
  let totalBytes = 0;
  try {
    const entries = readdirSync(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryFullPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        totalBytes += calculateDirectoryDiskUsage(entryFullPath);
      } else if (entry.isFile()) {
        try {
          totalBytes += statSync(entryFullPath).size;
        } catch {
          /* skip unreadable files */
        }
      }
    }
  } catch {
    /* skip unreadable directories */
  }
  return totalBytes;
}

function parseYamlSimple(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  const indentStack: { indent: number; container: Record<string, unknown> }[] = [
    { indent: -1, container: result },
  ];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    while (indentStack.length > 1 && indentStack[indentStack.length - 1]!.indent >= indent) {
      indentStack.pop();
    }

    const parentContainer = indentStack[indentStack.length - 1]!.container;

    if (trimmed.startsWith("- ")) {
      const currentParentKey = Object.keys(parentContainer).pop();
      if (currentParentKey) {
        const existingValue = parentContainer[currentParentKey];
        if (!Array.isArray(existingValue)) {
          parentContainer[currentParentKey] = [];
        }
        (parentContainer[currentParentKey] as unknown[]).push(trimmed.slice(2).trim());
      }
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const rawValue = trimmed.slice(colonIndex + 1).trim();

    if (!rawValue) {
      const nestedObject: Record<string, unknown> = {};
      parentContainer[key] = nestedObject;
      indentStack.push({ indent, container: nestedObject });
    } else {
      parentContainer[key] = rawValue;
    }
  }

  return result;
}

function countTriggersInConfig(parsedConfig: Record<string, unknown>): number {
  let triggerCount = 0;

  const triggers = parsedConfig["triggers"] as Record<string, unknown> | undefined;
  if (triggers && typeof triggers === "object") {
    for (const triggerCategory of Object.values(triggers)) {
      if (Array.isArray(triggerCategory)) {
        triggerCount += triggerCategory.length;
      }
    }
  }

  const scheduler = parsedConfig["scheduler"] as Record<string, unknown> | undefined;
  if (scheduler && typeof scheduler === "object") {
    const schedulerCrons = scheduler["crons"];
    if (Array.isArray(schedulerCrons)) triggerCount += schedulerCrons.length;
    const schedulerWatchers = scheduler["watchers"];
    if (Array.isArray(schedulerWatchers)) triggerCount += schedulerWatchers.length;
  }

  return triggerCount;
}

interface NotificationChannelInfo {
  name: string;
  provider: string;
}

function extractNotificationChannelsFromConfig(
  parsedConfig: Record<string, unknown>,
): NotificationChannelInfo[] {
  const channelInfoList: NotificationChannelInfo[] = [];

  const notifications = parsedConfig["notifications"] as Record<string, unknown> | undefined;
  if (!notifications || typeof notifications !== "object") return channelInfoList;

  const channels = notifications["channels"];
  if (!Array.isArray(channels)) return channelInfoList;

  for (const channelEntry of channels) {
    if (typeof channelEntry === "object" && channelEntry !== null) {
      const channelRecord = channelEntry as Record<string, unknown>;
      channelInfoList.push({
        name: String(channelRecord["name"] || "unnamed"),
        provider: String(channelRecord["provider"] || "unknown"),
      });
    }
  }

  return channelInfoList;
}

function renderCheckResult(checkResult: CheckResult): void {
  const statusIcon = STATUS_ICONS[checkResult.status];
  const indentation = checkResult.indented ? "               " : "";
  if (checkResult.indented) {
    console.log(`${indentation}${statusIcon} ${checkResult.message}`);
  } else {
    const paddedLabel = checkResult.label.padEnd(14);
    console.log(`  ${paddedLabel} ${statusIcon} ${checkResult.message}`);
  }
}

// ---------------------------------------------------------------------------
// Individual health checks
// ---------------------------------------------------------------------------

async function checkDaemonStatus(resultCollector: CheckResult[]): Promise<void> {
  const daemonPid = readDaemonPidFromFile();

  if (daemonPid === null) {
    resultCollector.push({
      label: "Daemon:",
      status: "warn",
      message: "not running (no PID file)",
    });
    return;
  }

  if (!isProcessAlive(daemonPid)) {
    resultCollector.push({
      label: "Daemon:",
      status: "warn",
      message: `not running (stale PID file: ${daemonPid})`,
    });
    return;
  }

  const daemonGrpcUrl = process.env.KRAKEN_SCHEDULER_URL || DEFAULT_DAEMON_GRPC_URL;

  try {
    const grpcTransport = createGrpcTransport({ baseUrl: daemonGrpcUrl });
    const daemonServiceClient = createClient(DaemonService, grpcTransport);

    const statusResponse = await daemonServiceClient.getStatus({});
    const uptimeDisplay = formatUptimeDuration(Number(statusResponse.uptimeSeconds));

    resultCollector.push({
      label: "Daemon:",
      status: "ok",
      message: `running (PID ${daemonPid}, uptime ${uptimeDisplay})`,
    });

    resultCollector.push({
      label: "",
      status: "ok",
      message: `workers ${statusResponse.activeWorkers}/${statusResponse.maxWorkers} active, ${statusResponse.pendingTasks} pending`,
      indented: true,
    });
  } catch {
    resultCollector.push({
      label: "Daemon:",
      status: "ok",
      message: `running (PID ${daemonPid}, gRPC not yet responding)`,
    });
  }
}

async function checkGrpcConnectivity(resultCollector: CheckResult[]): Promise<void> {
  const daemonGrpcUrl = process.env.KRAKEN_SCHEDULER_URL || DEFAULT_DAEMON_GRPC_URL;

  try {
    const grpcTransport = createGrpcTransport({ baseUrl: daemonGrpcUrl });
    const daemonServiceClient = createClient(DaemonService, grpcTransport);
    await daemonServiceClient.getStatus({});

    resultCollector.push({
      label: "gRPC:",
      status: "ok",
      message: `${daemonGrpcUrl.replace("http://", "")} responding`,
    });
  } catch {
    resultCollector.push({
      label: "gRPC:",
      status: "warn",
      message: `${daemonGrpcUrl.replace("http://", "")} not responding`,
    });
  }
}

function checkApiKeys(resultCollector: CheckResult[]): void {
  const apiKeyEnvironmentVariables = [
    { variableName: "OPENROUTER_API_KEY", alternativeName: "KRAKEN_OPENROUTER_API_KEY" },
    { variableName: "ANTHROPIC_API_KEY", alternativeName: undefined },
    { variableName: "OPENAI_API_KEY", alternativeName: undefined },
  ];

  let isFirstApiKeyEntry = true;

  for (const apiKeyDefinition of apiKeyEnvironmentVariables) {
    const primaryValue = Bun.env[apiKeyDefinition.variableName];
    const alternativeValue = apiKeyDefinition.alternativeName
      ? Bun.env[apiKeyDefinition.alternativeName]
      : undefined;
    const isKeySet = !!(primaryValue || alternativeValue);

    if (isFirstApiKeyEntry) {
      resultCollector.push({
        label: "API Keys:",
        status: isKeySet ? "ok" : "warn",
        message: isKeySet
          ? `${apiKeyDefinition.variableName} set`
          : `${apiKeyDefinition.variableName} not set`,
      });
      isFirstApiKeyEntry = false;
    } else {
      resultCollector.push({
        label: "",
        status: isKeySet ? "ok" : "warn",
        message: isKeySet
          ? `${apiKeyDefinition.variableName} set`
          : `${apiKeyDefinition.variableName} not set`,
        indented: true,
      });
    }
  }
}

function checkEnvFile(resultCollector: CheckResult[]): void {
  const globalEnvFilePath = join(KRAKEN_HOME, ".env");
  const envFileExists = existsSync(globalEnvFilePath);

  resultCollector.push({
    label: ".env file:",
    status: envFileExists ? "ok" : "warn",
    message: envFileExists ? "~/.kraken/.env exists" : "~/.kraken/.env not found",
  });
}

function checkGitRepository(resultCollector: CheckResult[]): void {
  try {
    const gitStatusResult = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--is-inside-work-tree"],
      stdout: "pipe",
      stderr: "pipe",
    });

    if (gitStatusResult.exitCode !== 0) {
      resultCollector.push({
        label: "Git:",
        status: "warn",
        message: "not a git repository",
      });
      return;
    }

    const dirtyCheckResult = Bun.spawnSync({
      cmd: ["git", "status", "--porcelain"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const hasUncommittedChanges =
      dirtyCheckResult.exitCode === 0 && dirtyCheckResult.stdout.toString().trim().length > 0;

    resultCollector.push({
      label: "Git:",
      status: "ok",
      message: hasUncommittedChanges
        ? "repo detected, working tree has changes"
        : "repo detected, clean working tree",
    });
  } catch {
    resultCollector.push({
      label: "Git:",
      status: "warn",
      message: "git not available",
    });
  }
}

function checkWorktrees(resultCollector: CheckResult[]): void {
  const krakenWorktreesDirectoryPath = join(process.cwd(), ".kraken-worktrees");

  if (!existsSync(krakenWorktreesDirectoryPath)) {
    resultCollector.push({
      label: "Worktrees:",
      status: "ok",
      message: "0 active",
    });
    return;
  }

  try {
    const worktreeDirectoryEntries = readdirSync(krakenWorktreesDirectoryPath, {
      withFileTypes: true,
    });
    const activeWorktreeDirectories = worktreeDirectoryEntries.filter((entry) =>
      entry.isDirectory(),
    );
    const activeWorktreeCount = activeWorktreeDirectories.length;

    if (activeWorktreeCount === 0) {
      resultCollector.push({
        label: "Worktrees:",
        status: "ok",
        message: "0 active",
      });
      return;
    }

    const totalDiskUsageBytes = calculateDirectoryDiskUsage(krakenWorktreesDirectoryPath);
    const formattedDiskUsage = formatBytesAsHumanReadable(totalDiskUsageBytes);

    resultCollector.push({
      label: "Worktrees:",
      status: "ok",
      message: `${activeWorktreeCount} active (${formattedDiskUsage})`,
    });
  } catch {
    resultCollector.push({
      label: "Worktrees:",
      status: "warn",
      message: "unable to read .kraken-worktrees/",
    });
  }
}

function checkConfigurationFile(resultCollector: CheckResult[]): void {
  const krakenYmlPath = join(KRAKEN_HOME, "kraken.yml");

  if (!existsSync(krakenYmlPath)) {
    resultCollector.push({
      label: "Config:",
      status: "warn",
      message: "~/.kraken/kraken.yml not found -- run 'kraken init'",
    });
    return;
  }

  try {
    const configFileContents = readFileSync(krakenYmlPath, "utf-8");
    const parsedConfiguration = parseYamlSimple(configFileContents);

    const triggerCount = countTriggersInConfig(parsedConfiguration);
    const notificationChannels = extractNotificationChannelsFromConfig(parsedConfiguration);
    const notificationChannelCount = notificationChannels.length;

    const detailParts: string[] = [];
    detailParts.push(`${triggerCount} trigger${triggerCount !== 1 ? "s" : ""}`);
    detailParts.push(
      `${notificationChannelCount} notification channel${notificationChannelCount !== 1 ? "s" : ""}`,
    );

    resultCollector.push({
      label: "Config:",
      status: "ok",
      message: `~/.kraken/kraken.yml (${detailParts.join(", ")})`,
    });

    for (const channelInfo of notificationChannels) {
      resultCollector.push({
        label: "",
        status: "ok",
        message: `${channelInfo.name} (${channelInfo.provider})`,
        indented: true,
      });
    }
  } catch {
    resultCollector.push({
      label: "Config:",
      status: "fail",
      message: "~/.kraken/kraken.yml exists but cannot be parsed",
    });
  }
}

function checkToolchain(resultCollector: CheckResult[]): void {
  const bunCheck = checkCommandAvailability("bun", ["--version"]);
  resultCollector.push({
    label: "Bun:",
    status: bunCheck.available ? "ok" : "fail",
    message: bunCheck.available ? `v${bunCheck.version}` : "not installed (https://bun.sh)",
  });

  const cargoCheck = checkCommandAvailability("cargo", ["--version"]);
  resultCollector.push({
    label: "Rust/Cargo:",
    status: cargoCheck.available ? "ok" : "warn",
    message: cargoCheck.available
      ? cargoCheck.version
      : "not installed (https://rustup.rs)",
  });

  const goCheck = checkCommandAvailability("go", ["version"]);
  resultCollector.push({
    label: "Go:",
    status: goCheck.available ? "ok" : "warn",
    message: goCheck.available ? goCheck.version : "not installed (https://go.dev/dl)",
  });
}

function checkBinaries(resultCollector: CheckResult[]): void {
  const schedulerReleaseBinaryPath = join(
    KRAKEN_ROOT,
    "apps",
    "scheduler",
    "target",
    "release",
    "scheduler",
  );
  const schedulerDebugBinaryPath = join(
    KRAKEN_ROOT,
    "apps",
    "scheduler",
    "target",
    "debug",
    "scheduler",
  );
  const schedulerBinaryExists =
    existsSync(schedulerReleaseBinaryPath) || existsSync(schedulerDebugBinaryPath);

  resultCollector.push({
    label: "Scheduler:",
    status: schedulerBinaryExists ? "ok" : "warn",
    message: schedulerBinaryExists
      ? existsSync(schedulerReleaseBinaryPath)
        ? "release build found"
        : "debug build found"
      : "not built -- run setup.sh",
  });

  const gatewayBinaryPath = join(KRAKEN_ROOT, "apps", "gateway", "bin", "gateway");
  const gatewayBinaryExists = existsSync(gatewayBinaryPath);

  resultCollector.push({
    label: "Gateway:",
    status: gatewayBinaryExists ? "ok" : "warn",
    message: gatewayBinaryExists ? "built binary found" : "not built -- run setup.sh",
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function execute(_args: string[]): Promise<void> {
  console.log(`\n  ${bold("Kraken Doctor")} ${colorize(`v${VERSION}`, "dim")}\n`);

  const allCheckResults: CheckResult[] = [];

  step("daemon & gRPC");
  await checkDaemonStatus(allCheckResults);
  await checkGrpcConnectivity(allCheckResults);

  step("API keys");
  checkApiKeys(allCheckResults);
  checkEnvFile(allCheckResults);

  step("git & worktrees");
  checkGitRepository(allCheckResults);
  checkWorktrees(allCheckResults);

  step("configuration");
  checkConfigurationFile(allCheckResults);

  step("toolchain");
  checkToolchain(allCheckResults);

  step("binaries");
  checkBinaries(allCheckResults);

  console.log(`\n${bold("  Results")}\n`);
  for (const checkResult of allCheckResults) {
    renderCheckResult(checkResult);
  }

  const failingChecks = allCheckResults.filter(
    (checkResult) => checkResult.status === "fail",
  );
  const warningChecks = allCheckResults.filter(
    (checkResult) => checkResult.status === "warn",
  );
  const passingChecks = allCheckResults.filter(
    (checkResult) => checkResult.status === "ok",
  );

  console.log(
    `\n  ${colorize(`${passingChecks.length} passed`, "green")}, ${colorize(`${warningChecks.length} warnings`, "yellow")}, ${colorize(`${failingChecks.length} errors`, failingChecks.length > 0 ? "red" : "dim")}\n`,
  );

  if (failingChecks.length > 0) {
    process.exit(1);
  }
}
