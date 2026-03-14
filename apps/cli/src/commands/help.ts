import { printBanner, bold, colorize } from "@/constants.ts";
import { COMMANDS } from "@/index.ts";

export async function execute(_args: string[]): Promise<void> {
  printBanner();

  console.log(`  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken", "cyan")} ${colorize("[command] [options]", "dim")}\n`);

  console.log(`  ${bold("Commands:")}\n`);

  const maxLength = Math.max(...Object.keys(COMMANDS).map((k) => k.length));

  for (const [name, { description }] of Object.entries(COMMANDS)) {
    const paddedName = name.padEnd(maxLength + 2);
    console.log(`    ${colorize(paddedName, "cyan")}${description}`);
  }

  console.log(`\n  ${bold("Start options:")}\n`);
  console.log(`    ${colorize("--no-scheduler", "cyan")}  start without the scheduler service`);
  console.log(`    ${colorize("--no-gateway", "cyan")}    start without the gateway service`);
  console.log(
    `    ${colorize("--dev", "cyan")}           use cargo run / go run instead of built binaries`,
  );

  console.log(`\n  ${bold("Examples:")}\n`);
  console.log(`    ${colorize("kraken", "cyan")}                    start TUI with all services`);
  console.log(
    `    ${colorize("kraken init", "cyan")}               setup kraken in current project`,
  );
  console.log(`    ${colorize("kraken doctor", "cyan")}             check system health`);
  console.log(`    ${colorize("kraken config get", "cyan")} languageModel.model`);
  console.log(`    ${colorize("kraken plugins create", "cyan")} my-plugin`);
  console.log();
}
