import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { KRAKEN_HOME } from "@/constants.ts";

function tryRemove(filePath: string, deferred: string[]): void {
  if (!existsSync(filePath)) return;
  try {
    rmSync(filePath, { recursive: true, force: true });
  } catch {
    deferred.push(filePath);
  }
}

function removeFromShellConfig(rcFile: string, marker: string): boolean {
  if (!existsSync(rcFile)) return false;

  const content = readFileSync(rcFile, "utf-8");
  if (!content.includes(marker)) return false;

  const filtered = content
    .split("\n")
    .filter((line) => !line.includes(marker) && !line.includes("# kraken"))
    .join("\n");

  writeFileSync(rcFile, filtered);
  return true;
}

export async function execute(_args: string[]): Promise<void> {
  p.intro("Uninstall kraken");

  p.log.warn("This will permanently delete ALL kraken data:");
  p.log.message(`  ${KRAKEN_HOME}/kraken.yml     (configuration)`);
  p.log.message(`  ${KRAKEN_HOME}/.env           (API keys)`);
  p.log.message(`  ${KRAKEN_HOME}/agent.db       (conversations, tasks, memory)`);
  p.log.message(`  ${KRAKEN_HOME}/plugins/       (installed plugins)`);
  p.log.message(`  ${KRAKEN_HOME}/screenshots/   (browser screenshots)`);
  p.log.message(`  ~/.bun/bin/kraken             (CLI binary)`);

  const shouldContinue = await p.confirm({
    message: "Delete everything and uninstall kraken?",
    initialValue: false,
  });

  if (p.isCancel(shouldContinue) || !shouldContinue) {
    p.cancel("Uninstall cancelled.");
    return;
  }

  const spinnerInstance = p.spinner();
  spinnerInstance.start("Removing kraken");

  // Collect paths that couldn't be deleted (e.g. the running process on Windows)
  const deferredDeletes: string[] = [];

  // Delete contents of KRAKEN_HOME one-by-one instead of the root directory,
  // because the running process lives inside ~/.kraken/lib/ and the OS will
  // block deletion of a directory that contains a running executable.
  if (existsSync(KRAKEN_HOME)) {
    for (const entry of readdirSync(KRAKEN_HOME)) {
      tryRemove(join(KRAKEN_HOME, entry), deferredDeletes);
    }
    // Try removing the now-empty directory; if still locked, defer it
    tryRemove(KRAKEN_HOME, deferredDeletes);
  }

  const home = homedir();

  const bunBinKraken = join(home, ".bun", "bin", "kraken");
  tryRemove(bunBinKraken, deferredDeletes);

  const bunBinKrakenExe = join(home, ".bun", "bin", "kraken.exe");
  tryRemove(bunBinKrakenExe, deferredDeletes);

  // Remove the global node_modules symlink created by `bun link`
  const bunGlobalLink = join(home, ".bun", "install", "global", "node_modules", "kraken");
  tryRemove(bunGlobalLink, deferredDeletes);

  const pathMarker = ".kraken/bin";
  const shellConfigs = [
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".config", "fish", "config.fish"),
  ];

  for (const rcFile of shellConfigs) {
    removeFromShellConfig(rcFile, pathMarker);
  }

  // On Windows, also remove ~/.kraken/bin from the user PATH env variable
  if (process.platform === "win32") {
    const krakenBin = join(KRAKEN_HOME, "bin");
    const userPath = Bun.env.PATH ?? "";
    const filtered = userPath
      .split(";")
      .filter((p) => p !== krakenBin)
      .join(";");
    Bun.spawnSync([
      "powershell",
      "-Command",
      `[Environment]::SetEnvironmentVariable("PATH","${filtered.replaceAll('"', '`"')}","User")`,
    ]);
  }

  // On Windows the running process locks files — schedule deletion after exit.
  // We use a PowerShell loop that retries until the files are unlocked.
  if (deferredDeletes.length > 0 && process.platform === "win32") {
    // Always try cleaning the root directory last
    if (!deferredDeletes.includes(KRAKEN_HOME)) {
      deferredDeletes.push(KRAKEN_HOME);
    }
    const psCommands = deferredDeletes
      .map(
        (f) =>
          `$p='${f.replaceAll("'", "''")}';for($i=0;$i -lt 10;$i++){Start-Sleep -Seconds 1;if(Test-Path $p){Remove-Item -Force -Recurse $p -ErrorAction SilentlyContinue}else{break}}`,
      )
      .join(";");
    Bun.spawn(["powershell", "-WindowStyle", "Hidden", "-Command", psCommands], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }

  spinnerInstance.stop("Kraken removed");

  if (deferredDeletes.length > 0) {
    p.log.info("Some files are locked and will be cleaned up in a few seconds.");
  }

  p.outro("Restart your terminal to apply PATH changes.");
}
