import { existsSync } from "node:fs";
import { join } from "node:path";
import { KRAKEN_ROOT, KRAKEN_HOME, VERSION, step, bold, colorize } from "@/constants.ts";

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

function checkCommand(command: string, args: string[]): { available: boolean; version: string } {
  try {
    const result = Bun.spawnSync({ cmd: [command, ...args], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      return {
        available: true,
        version: result.stdout.toString().trim().split("\n")[0] || "unknown",
      };
    }
    return { available: false, version: "" };
  } catch {
    return { available: false, version: "" };
  }
}

async function checkServiceHealth(url: string, timeoutMs: number = 2000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function renderResult(result: CheckResult): void {
  const icon =
    result.status === "ok"
      ? colorize("✓", "green")
      : result.status === "warn"
        ? colorize("!", "yellow")
        : colorize("✗", "red");
  console.log(`  ${icon} ${bold(result.name)}: ${result.message}`);
}

export async function execute(_args: string[]): Promise<void> {
  console.log(`\n  ${bold("Kraken Doctor")} ${colorize(`v${VERSION}`, "dim")}\n`);

  const results: CheckResult[] = [];

  step("checking toolchain");

  const bun = checkCommand("bun", ["--version"]);
  results.push({
    name: "Bun",
    status: bun.available ? "ok" : "fail",
    message: bun.available ? `v${bun.version}` : "not installed (https://bun.sh)",
  });

  const cargo = checkCommand("cargo", ["--version"]);
  results.push({
    name: "Rust/Cargo",
    status: cargo.available ? "ok" : "warn",
    message: cargo.available
      ? cargo.version
      : "not installed -- scheduler will use fallback (https://rustup.rs)",
  });

  const golang = checkCommand("go", ["version"]);
  results.push({
    name: "Go",
    status: golang.available ? "ok" : "warn",
    message: golang.available
      ? golang.version
      : "not installed -- gateway will use fallback (https://go.dev/dl)",
  });

  step("checking binaries");

  const schedulerRelease = join(KRAKEN_ROOT, "apps", "scheduler", "target", "release", "scheduler");
  const schedulerDebug = join(KRAKEN_ROOT, "apps", "scheduler", "target", "debug", "scheduler");
  const schedulerExists = existsSync(schedulerRelease) || existsSync(schedulerDebug);
  results.push({
    name: "Scheduler binary",
    status: schedulerExists ? "ok" : "warn",
    message: schedulerExists
      ? existsSync(schedulerRelease)
        ? "release build found"
        : "debug build found"
      : "not built -- will use 'cargo run' (run setup.sh to build)",
  });

  const gatewayBinary = join(KRAKEN_ROOT, "apps", "gateway", "bin", "gateway");
  const gatewayExists = existsSync(gatewayBinary);
  results.push({
    name: "Gateway binary",
    status: gatewayExists ? "ok" : "warn",
    message: gatewayExists
      ? "built binary found"
      : "not built -- will use 'go run' (run setup.sh to build)",
  });

  step("checking configuration");

  const globalYml = join(KRAKEN_HOME, "kraken.yml");
  const foundYml = existsSync(globalYml) ? globalYml : null;
  results.push({
    name: "kraken.yml",
    status: foundYml ? "ok" : "warn",
    message: foundYml ? `found at ${foundYml}` : "not found -- run 'kraken init'",
  });

  const globalEnv = join(KRAKEN_HOME, ".env");
  const hasEnvFile = existsSync(globalEnv);
  const hasEnvVar = !!(
    Bun.env.OPENROUTER_API_KEY ||
    Bun.env.ANTHROPIC_API_KEY ||
    Bun.env.OPENAI_API_KEY
  );
  results.push({
    name: "API Key",
    status: hasEnvFile || hasEnvVar ? "ok" : "warn",
    message: hasEnvVar
      ? "found in environment"
      : hasEnvFile
        ? `found in ${globalEnv}`
        : "not configured -- run 'kraken init'",
  });

  step("checking services");

  const schedulerHealthy = await checkServiceHealth("http://localhost:50051");
  results.push({
    name: "Scheduler (:50051)",
    status: schedulerHealthy ? "ok" : "warn",
    message: schedulerHealthy
      ? "responding"
      : "not running (will start automatically with 'kraken')",
  });

  const gatewayHealthy = await checkServiceHealth("http://localhost:50052");
  results.push({
    name: "Gateway (:50052)",
    status: gatewayHealthy ? "ok" : "warn",
    message: gatewayHealthy ? "responding" : "not running (will start automatically with 'kraken')",
  });

  if (hasEnvVar || hasEnvFile) {
    step("checking connectivity");

    const apiKey = Bun.env.OPENROUTER_API_KEY;
    if (apiKey) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        results.push({
          name: "OpenRouter API",
          status: response.ok ? "ok" : "warn",
          message: response.ok ? "connected" : `returned ${response.status}`,
        });
      } catch {
        results.push({
          name: "OpenRouter API",
          status: "warn",
          message: "unreachable -- check your internet connection",
        });
      }
    }
  }

  console.log(`\n${bold("  Summary")}\n`);
  for (const result of results) {
    renderResult(result);
  }

  const failures = results.filter((r) => r.status === "fail");
  const warnings = results.filter((r) => r.status === "warn");
  const passing = results.filter((r) => r.status === "ok");

  console.log(
    `\n  ${colorize(`${passing.length} passed`, "green")}, ${colorize(`${warnings.length} warnings`, "yellow")}, ${colorize(`${failures.length} errors`, failures.length > 0 ? "red" : "dim")}\n`,
  );

  if (failures.length > 0) {
    process.exit(1);
  }
}
