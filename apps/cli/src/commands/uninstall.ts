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

  p.log.warn("The following will be removed:");
  p.log.message(`  ${KRAKEN_HOME}  (installation directory)`);
  p.log.message(`  ~/.bun/bin/kraken  (CLI binary)`);
  p.log.message(`  ~/.bun/install/global/node_modules/kraken  (global link)`);

  const shouldContinue = await p.confirm({
    message: "Are you sure you want to uninstall kraken?",
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
  if (existsSync(bunGlobalLink)) {
    rmSync(bunGlobalLink, { recursive: true, force: true });
  }

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

  // On Windows the running .exe can't delete itself — schedule deletion after exit
  if (deferredDeletes.length > 0 && process.platform === "win32") {
    const delArgs = deferredDeletes.map((f) => `"${f}"`).join(" & del /f /q ");
    Bun.spawn(["cmd", "/c", `ping -n 2 127.0.0.1 >nul & del /f /q ${delArgs}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }

  spinnerInstance.stop("Kraken removed");

  p.outro("Restart your terminal to apply PATH changes.");
}
