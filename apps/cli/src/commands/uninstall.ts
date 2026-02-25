import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { KRAKEN_HOME } from "@/constants.ts";

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
  p.log.message(`  ~/.bun/bin/kraken  (CLI symlink)`);

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

  const bunBinKraken = join(homedir(), ".bun", "bin", "kraken");
  if (existsSync(bunBinKraken)) {
    rmSync(bunBinKraken, { force: true });
  }

  const home = homedir();
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

  try {
    Bun.spawnSync({ cmd: ["bun", "unlink", "kraken"], stdout: "ignore", stderr: "ignore" });
  } catch {
    /* may not exist */
  }

  spinnerInstance.stop("Kraken removed");

  p.outro("Restart your terminal to apply PATH changes.");
}
