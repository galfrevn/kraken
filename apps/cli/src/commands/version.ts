import { VERSION, colorize } from "@/constants.ts";

export async function execute(_args: string[]): Promise<void> {
  console.log(`kraken ${colorize(`v${VERSION}`, "cyan")}`);
}
