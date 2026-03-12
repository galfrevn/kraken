import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { KRAKEN_HOME } from "@/constants.ts";

function tryRemove(filePath: string, deferred: string[]): void {
  if (!existsSync(filePath)) return;
  try {
    rmSync(filePath, { force: true });
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

  if (existsSync(KRAKEN_HOME)) {
    rmSync(KRAKEN_HOME, { recursive: true, force: true });
  }

  const home = homedir();

  // Collect paths that couldn't be deleted (e.g. locked .exe on Windows)
  const deferredDeletes: string[] = [];

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

  // On Windows the running .exe can't delete itself — schedule deletion after exit.
  // We use a PowerShell loop that retries until the files are unlocked.
  if (deferredDeletes.length > 0 && process.platform === "win32") {
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
