import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KRAKEN_ROOT, KRAKEN_HOME } from "@/constants.ts";
import { startSplashScreen } from "@/splash.ts";

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

function spawnGateway(dev: boolean): Subprocess {
  const builtBinary = join(KRAKEN_ROOT, "apps", "gateway", "bin", "gateway");
  const gatewayDirectory = join(KRAKEN_ROOT, "apps", "gateway");
  const envVars = { ...process.env, DOTENV_PATH: join(KRAKEN_HOME, ".env") };

  if (!dev && existsSync(builtBinary)) {
    return spawn({ cmd: [builtBinary], cwd: gatewayDirectory, stdout: "ignore", stderr: "ignore", env: envVars });
  }

  return spawn({ cmd: ["go", "run", "./cmd/gateway"], cwd: gatewayDirectory, stdout: "ignore", stderr: "ignore", env: envVars });
}

async function waitForService(url: string, timeoutMs: number = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      await Bun.sleep(200);
    }
  }
  return false;
}

export async function execute(args: string[]): Promise<void> {
  const flags = parseStartFlags(args);

  process.on("SIGINT", () => { killAllChildren(); process.exit(0); });
  process.on("SIGTERM", () => { killAllChildren(); process.exit(0); });
  process.on("exit", () => { killAllChildren(); });

  const needsServices = !flags.noScheduler || !flags.noGateway;
  const splash = needsServices ? startSplashScreen() : null;

  if (!flags.noScheduler) {
    childProcesses.push(spawnScheduler(flags.dev));
  }

  if (!flags.noGateway) {
    childProcesses.push(spawnGateway(flags.dev));
  }

  if (needsServices) {
    const checks: Promise<boolean>[] = [];
    if (!flags.noScheduler) checks.push(waitForService("http://localhost:50051"));
    if (!flags.noGateway) checks.push(waitForService("http://localhost:50052"));

    await Promise.all(checks);
  }

  splash?.stop();

  // @ts-expect-error -- dynamic cross-package import resolved by Bun at runtime
  const { main } = (await import("../../../tui/src/index.tsx")) as { main: () => Promise<void> };
  await main();
}
