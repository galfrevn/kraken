import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KRAKEN_ROOT, KRAKEN_HOME } from "@/constants.ts";
import { loadConfiguration } from "@core/configuration/loader.ts";
import type { AgentConfiguration } from "@core/configuration/schema.ts";

let daemonProcess: Subprocess | null = null;
let shuttingDown = false;

interface StartFlags {
  noDaemon: boolean;
  dev: boolean;
}

function parseStartFlags(args: string[]): StartFlags {
  return {
    noDaemon: args.includes("--no-daemon"),
    dev: args.includes("--dev"),
  };
}

function killDaemon(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  if (daemonProcess) {
    try {
      daemonProcess.kill();
    } catch {
      /* already exited */
    }
  }
}

function buildDaemonEnvironment(configuration: AgentConfiguration): Record<string, string | undefined> {
  const environmentVariables: Record<string, string | undefined> = {
    ...process.env,
    DOTENV_PATH: join(KRAKEN_HOME, ".env"),
    LLM_PROVIDER: configuration.languageModel.provider,
  };

  const apiKey = configuration.languageModel.apiKey;
  if (apiKey) {
    switch (configuration.languageModel.provider) {
      case "openrouter":
        environmentVariables.OPENROUTER_API_KEY = apiKey;
        break;
      case "openai":
        environmentVariables.OPENAI_API_KEY = apiKey;
        break;
      case "anthropic":
        environmentVariables.ANTHROPIC_API_KEY = apiKey;
        break;
    }
  }

  const baseUrl = configuration.languageModel.baseUrl;
  if (baseUrl) {
    switch (configuration.languageModel.provider) {
      case "openrouter":
        environmentVariables.OPENROUTER_BASE_URL = baseUrl;
        break;
      case "openai":
        environmentVariables.OPENAI_BASE_URL = baseUrl;
        break;
      case "anthropic":
        environmentVariables.ANTHROPIC_BASE_URL = baseUrl;
        break;
      case "ollama":
        environmentVariables.OLLAMA_BASE_URL = baseUrl;
        break;
    }
  }

  return environmentVariables;
}

function spawnDaemon(developmentMode: boolean, configuration: AgentConfiguration): Subprocess {
  const releaseBinaryName = process.platform === "win32" ? "kraken-daemon.exe" : "kraken-daemon";
  const releaseBinaryPath = join(KRAKEN_ROOT, "apps", "daemon", "target", "release", releaseBinaryName);
  const debugBinaryPath = join(KRAKEN_ROOT, "apps", "daemon", "target", "debug", releaseBinaryName);
  const daemonDirectory = join(KRAKEN_ROOT, "apps", "daemon");
  const daemonEnvironment = buildDaemonEnvironment(configuration);

  if (!developmentMode && existsSync(releaseBinaryPath)) {
    return spawn({
      cmd: [releaseBinaryPath],
      cwd: KRAKEN_ROOT,
      stdout: "ignore",
      stderr: "ignore",
      env: daemonEnvironment,
    });
  }

  if (!developmentMode && existsSync(debugBinaryPath)) {
    return spawn({
      cmd: [debugBinaryPath],
      cwd: KRAKEN_ROOT,
      stdout: "ignore",
      stderr: "ignore",
      env: daemonEnvironment,
    });
  }

  return spawn({
    cmd: ["cargo", "run", "--bin", "kraken-daemon", "--quiet"],
    cwd: daemonDirectory,
    stdout: "ignore",
    stderr: "ignore",
    env: daemonEnvironment,
  });
}

export async function execute(args: string[]): Promise<void> {
  const flags = parseStartFlags(args);
  const configuration = await loadConfiguration();

  process.on("SIGINT", () => {
    killDaemon();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    killDaemon();
    process.exit(0);
  });
  process.on("exit", () => {
    killDaemon();
  });

  if (!flags.noDaemon) {
    daemonProcess = spawnDaemon(flags.dev, configuration);
    await Bun.sleep(1500);
  }

  // @ts-expect-error -- dynamic cross-package import resolved by Bun at runtime
  const { main } = (await import("../../../tui/src/index.tsx")) as { main: () => Promise<void> };
  await main();
}
