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
  console.log(`    ${colorize("--no-daemon", "cyan")}     start without the daemon process`);
  console.log(
    `    ${colorize("--dev", "cyan")}           use cargo run instead of built binaries`,
  );

  console.log(`\n  ${bold("Examples:")}\n`);
  console.log(`    ${colorize("kraken", "cyan")}                          start TUI with all services`);
  console.log(`    ${colorize("kraken init", "cyan")}                     setup kraken in current project`);
  console.log(`    ${colorize("kraken doctor", "cyan")}                   check system health`);
  console.log(`    ${colorize("kraken provider switch", "cyan")}          change LLM provider and model`);
  console.log(`    ${colorize("kraken notification add", "cyan")}         add a notification channel`);
  console.log(`    ${colorize("kraken trigger add", "cyan")}              add a new trigger`);
  console.log(`    ${colorize("kraken config validate", "cyan")}          validate configuration`);
  console.log(`    ${colorize("kraken config get", "cyan")} languageModel.model`);
  console.log(`    ${colorize("kraken plugins create", "cyan")} my-plugin`);
  console.log(`    ${colorize("kraken watch", "cyan")} src/ apps/          watch files and auto-submit reviews`);
  console.log();
}
