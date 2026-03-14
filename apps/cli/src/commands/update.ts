import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  KRAKEN_ROOT,
  GITHUB_REPO,
  VERSION,
  step,
  success,
  warn,
  fail,
  bold,
  colorize,
} from "@/constants.ts";

interface GitHubRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;
    return (await response.json()) as GitHubRelease;
  } catch {
    return null;
  }
}

function parseVersion(version: string): number[] {
  return version.replace(/^v/, "").split(".").map(Number);
}

function isNewerVersion(remote: string, local: string): boolean {
  const remoteNumbers = parseVersion(remote);
  const localNumbers = parseVersion(local);

  for (let i = 0; i < Math.max(remoteNumbers.length, localNumbers.length); i++) {
    const remotePart = remoteNumbers[i] ?? 0;
    const localPart = localNumbers[i] ?? 0;
    if (remotePart > localPart) return true;
    if (remotePart < localPart) return false;
  }
  return false;
}

async function updateFromSource(): Promise<boolean> {
  step("updating from source (git pull)");

  const gitDirectory = join(KRAKEN_ROOT, ".git");
  if (!existsSync(gitDirectory)) {
    fail("not a git repository -- cannot update from source");
    return false;
  }

  const pullResult = Bun.spawnSync({
    cmd: ["git", "pull", "--rebase"],
    cwd: KRAKEN_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (pullResult.exitCode !== 0) {
    fail(`git pull failed: ${pullResult.stderr.toString()}`);
    return false;
  }
  success("source code updated");

  step("installing dependencies");
  const bunInstall = Bun.spawnSync({
    cmd: ["bun", "install"],
    cwd: KRAKEN_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (bunInstall.exitCode !== 0) {
    warn("bun install had issues, but continuing...");
  }
  success("dependencies updated");

  const schedulerDirectory = join(KRAKEN_ROOT, "apps", "scheduler");
  if (existsSync(join(schedulerDirectory, "Cargo.toml"))) {
    step("rebuilding scheduler");
    const cargoBuild = Bun.spawnSync({
      cmd: ["cargo", "build", "--release"],
      cwd: schedulerDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (cargoBuild.exitCode === 0) {
      success("scheduler rebuilt");
    } else {
      warn("scheduler build failed -- will use cargo run as fallback");
    }
  }

  const gatewayDirectory = join(KRAKEN_ROOT, "apps", "gateway");
  if (existsSync(join(gatewayDirectory, "go.mod"))) {
    step("rebuilding gateway");
    const goBuild = Bun.spawnSync({
      cmd: ["go", "build", "-o", "./bin/gateway", "./cmd/gateway"],
      cwd: gatewayDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (goBuild.exitCode === 0) {
      success("gateway rebuilt");
    } else {
      warn("gateway build failed -- will use go run as fallback");
    }
  }

  return true;
}

export async function execute(_args: string[]): Promise<void> {
  console.log(`\n  ${bold("Current version:")} ${colorize(`v${VERSION}`, "cyan")}`);

  step("checking for updates");

  const release = await fetchLatestRelease();

  if (!release) {
    warn("could not reach GitHub API -- updating from source instead");
    const updated = await updateFromSource();
    if (updated) {
      console.log(`\n  ${bold("Update complete!")} Restart kraken to use the new version.\n`);
    }
    return;
  }

  const remoteVersion = release.tag_name;
  console.log(`  Latest release: ${colorize(remoteVersion, "cyan")}`);

  if (!isNewerVersion(remoteVersion, VERSION)) {
    success("you are already on the latest version");
    return;
  }

  console.log(
    `\n  ${colorize("New version available!", "green")} ${colorize(`v${VERSION}`, "dim")} → ${colorize(remoteVersion, "cyan")}`,
  );

  const updated = await updateFromSource();
  if (updated) {
    console.log(`\n  ${bold("Update complete!")} Restart kraken to use the new version.\n`);
  }
}
