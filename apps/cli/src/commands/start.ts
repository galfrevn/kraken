import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KRAKEN_ROOT, KRAKEN_HOME } from "@/constants.ts";
import { loadConfiguration } from "@core/configuration/loader.ts";
import type { AgentConfiguration } from "@core/configuration/schema.ts";

const childProcesses: Subprocess[] = [];
let shuttingDown = false;

interface StartFlags {
  noScheduler: boolean;
  noGateway: boolean;
  dev: boolean;
}

function parseStartFlags(args: string[]): StartFlags {
  return {
    noScheduler: args.includes("--no-scheduler"),
    noGateway: args.includes("--no-gateway"),
    dev: args.includes("--dev"),
  };
}

function killAllChildren(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of childProcesses) {
    try {
      child.kill();
    } catch {
      /* already exited */
    }
  }
}

function spawnScheduler(dev: boolean): Subprocess {
  const releaseBinary = join(KRAKEN_ROOT, "apps", "scheduler", "target", "release", "scheduler");
  const debugBinary = join(KRAKEN_ROOT, "apps", "scheduler", "target", "debug", "scheduler");
  const schedulerDirectory = join(KRAKEN_ROOT, "apps", "scheduler");

  if (!dev && existsSync(releaseBinary)) {
    return spawn({ cmd: [releaseBinary], cwd: schedulerDirectory, stdout: "ignore", stderr: "ignore" });
  }

  if (!dev && existsSync(debugBinary)) {
    return spawn({ cmd: [debugBinary], cwd: schedulerDirectory, stdout: "ignore", stderr: "ignore" });
  }

  return spawn({ cmd: ["cargo", "run", "--quiet"], cwd: schedulerDirectory, stdout: "ignore", stderr: "ignore" });
}

function buildGatewayEnv(configuration: AgentConfiguration): Record<string, string | undefined> {
  const envVars: Record<string, string | undefined> = {
    ...process.env,
    DOTENV_PATH: join(KRAKEN_HOME, ".env"),
    LLM_PROVIDER: configuration.languageModel.provider,
  };

  const apiKey = configuration.languageModel.apiKey;
  if (apiKey) {
    switch (configuration.languageModel.provider) {
      case "openrouter":
        envVars.OPENROUTER_API_KEY = apiKey;
        break;
      case "openai":
        envVars.OPENAI_API_KEY = apiKey;
        break;
      case "anthropic":
        envVars.ANTHROPIC_API_KEY = apiKey;
        break;
    }
  }

  const baseUrl = configuration.languageModel.baseUrl;
  if (baseUrl) {
    switch (configuration.languageModel.provider) {
      case "openrouter":
        envVars.OPENROUTER_BASE_URL = baseUrl;
        break;
      case "openai":
        envVars.OPENAI_BASE_URL = baseUrl;
        break;
      case "anthropic":
        envVars.ANTHROPIC_BASE_URL = baseUrl;
        break;
      case "ollama":
        envVars.OLLAMA_BASE_URL = baseUrl;
        break;
    }
  }

  return envVars;
}

function spawnGateway(dev: boolean, configuration: AgentConfiguration): Subprocess {
  const builtBinary = join(KRAKEN_ROOT, "apps", "gateway", "bin", "gateway");
  const gatewayDirectory = join(KRAKEN_ROOT, "apps", "gateway");
  const envVars = buildGatewayEnv(configuration);

  if (!dev && existsSync(builtBinary)) {
    return spawn({ cmd: [builtBinary], cwd: gatewayDirectory, stdout: "ignore", stderr: "ignore", env: envVars });
  }

  return spawn({ cmd: ["go", "run", "./cmd/gateway"], cwd: gatewayDirectory, stdout: "ignore", stderr: "ignore", env: envVars });
}

export async function execute(args: string[]): Promise<void> {
  const flags = parseStartFlags(args);
  const configuration = await loadConfiguration();

  process.on("SIGINT", () => { killAllChildren(); process.exit(0); });
  process.on("SIGTERM", () => { killAllChildren(); process.exit(0); });
  process.on("exit", () => { killAllChildren(); });

  if (!flags.noScheduler) {
    childProcesses.push(spawnScheduler(flags.dev));
  }

  if (!flags.noGateway) {
    childProcesses.push(spawnGateway(flags.dev, configuration));
  }

  // @ts-expect-error -- dynamic cross-package import resolved by Bun at runtime
  const { main } = (await import("../../../tui/src/index.tsx")) as { main: () => Promise<void> };
  await main();
}
