import { resolve } from "node:path";
import { homedir } from "node:os";

export const VERSION = "0.1.0";

export const KRAKEN_ROOT = resolve(import.meta.dir, "..", "..", "..");

export const KRAKEN_HOME = resolve(homedir(), ".kraken");

export const GITHUB_REPO = "galfrevn/kraken";

export const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} as const;

export function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

export function bold(text: string): string {
  return `${COLORS.bold}${text}${COLORS.reset}`;
}

export function success(message: string): void {
  console.log(`  ${colorize("✓", "green")} ${message}`);
}

export function warn(message: string): void {
  console.log(`  ${colorize("!", "yellow")} ${message}`);
}

export function fail(message: string): void {
  console.error(`  ${colorize("✗", "red")} ${message}`);
}

export function step(message: string): void {
  console.log(`\n${colorize("=>", "cyan")} ${bold(message)}`);
}

export function printBanner(): void {
  console.log(
    colorize(
      ` ██ ▄█▀ ██▀███   ▄▄▄       ██ ▄█▀▓█████  ███▄    █ 
 ██▄█▒ ▓██ ▒ ██▒▒████▄     ██▄█▒ ▓█   ▀  ██ ▀█   █ 
▓███▄░ ▓██ ░▄█ ▒▒██  ▀█▄  ▓███▄░ ▒███   ▓██  ▀█ ██▒
▓██ █▄ ▒██▀▀█▄  ░██▄▄▄▄██ ▓██ █▄ ▒▓█  ▄ ▓██▒  ▐▌██▒
▒██▒ █▄░██▓ ▒██▒ ▓█   ▓██▒▒██▒ █▄░▒████▒▒██░   ▓██░
▒ ▒▒ ▓▒░ ▒▓ ░▒▓░ ▒▒   ▓▒█░▒ ▒▒ ▓▒░░ ▒░ ░░ ▒░   ▒ ▒ 
░ ░▒ ▒░  ░▒ ░ ▒░  ▒   ▒▒ ░░ ░▒ ▒░ ░ ░  ░░ ░░   ░ ▒░
░ ░░ ░   ░░   ░   ░   ▒   ░ ░░ ░    ░      ░   ░ ░ 
░  ░      ░           ░  ░░  ░      ░  ░         ░ `,
      "cyan",
    ),
  );
  console.log(
    `\n  ${colorize("autonomous developer agent", "dim")}  ${colorize(`v${VERSION}`, "dim")}\n`,
  );
}
