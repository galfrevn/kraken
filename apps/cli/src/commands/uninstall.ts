import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
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

  // On Windows, also remove ~/.kraken/bin from the user PATH env variable.
  // Use reg.exe instead of PowerShell to avoid the terminal-minimize bug
  // caused by PowerShell's -WindowStyle Hidden.
  if (process.platform === "win32") {
    const krakenBin = join(KRAKEN_HOME, "bin");
    const userPath = Bun.env.PATH ?? "";
    const filtered = userPath
      .split(";")
      .filter((p) => p !== krakenBin)
      .join(";");
    Bun.spawnSync([
      "reg",
      "add",
      "HKCU\\Environment",
      "/v",
      "PATH",
      "/t",
      "REG_EXPAND_SZ",
      "/d",
      filtered,
      "/f",
    ], { stdio: ["ignore", "ignore", "ignore"] });
  }

  // On Windows the running process locks files — schedule deletion after exit.
  // Write a temporary batch script that retries deletion, avoiding PowerShell
  // which can minimize the caller's terminal window.
  if (deferredDeletes.length > 0 && process.platform === "win32") {
    if (!deferredDeletes.includes(KRAKEN_HOME)) {
      deferredDeletes.push(KRAKEN_HOME);
    }
    const batchLines = ["@echo off"];
    for (const f of deferredDeletes) {
      const escaped = f.replaceAll("/", "\\");
      batchLines.push(
        `for /L %%i in (1,1,10) do (`,
        `  if not exist "${escaped}" goto :next_${batchLines.length}`,
        `  timeout /t 1 /nobreak >nul`,
        `  rmdir /s /q "${escaped}" 2>nul`,
        `  del /f /q "${escaped}" 2>nul`,
        `)`,
        `:next_${batchLines.length}`,
      );
    }
    batchLines.push(`del "%~f0"`); // self-delete the batch file
    const tempDir = mkdtempSync(join(tmpdir(), "kraken-uninstall-"));
    const batchPath = join(tempDir, "cleanup.cmd");
    writeFileSync(batchPath, batchLines.join("\r\n"));
    Bun.spawn(["cmd", "/c", "start", "/b", batchPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }

  spinnerInstance.stop("Kraken removed");

  if (deferredDeletes.length > 0) {
    p.log.info("Some files are locked and will be cleaned up in a few seconds.");
  }

  p.outro("Restart your terminal to apply PATH changes.");
}
