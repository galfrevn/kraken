#!/usr/bin/env bun

import { VERSION } from "@/constants.ts";

type CommandModule = { execute: (args: string[]) => Promise<void> };

const COMMANDS: Record<string, { description: string; module: string }> = {
  start: { description: "Start the TUI with the daemon", module: "@/commands/start.ts" },
  chat: { description: "One-shot task submission to the daemon (pipe-friendly)", module: "@/commands/chat.ts" },
  daemon: { description: "Manage the kraken daemon (start/stop/status/restart/reload)", module: "@/commands/daemon.ts" },
  task: { description: "Manage tasks (list/submit/cancel/cleanup)", module: "@/commands/task.ts" },
  trigger: { description: "Manage triggers (list/add/remove/test)", module: "@/commands/trigger.ts" },
  provider: { description: "Switch LLM provider, model, or API key", module: "@/commands/provider.ts" },
  notification: { description: "Manage notification channels (list/add/remove)", module: "@/commands/notification.ts" },
  init: { description: "Initialize kraken in the current project", module: "@/commands/init.ts" },
  config: { description: "View, edit, or validate project configuration", module: "@/commands/config.ts" },
  doctor: { description: "Check system health and dependencies", module: "@/commands/doctor.ts" },
  plugins: { description: "Manage plugins", module: "@/commands/plugins.ts" },
  update: { description: "Update kraken to the latest version", module: "@/commands/update.ts" },
  uninstall: {
    description: "Uninstall kraken from your system",
    module: "@/commands/uninstall.ts",
  },
  version: { description: "Print version", module: "@/commands/version.ts" },
  help: { description: "Show this help message", module: "@/commands/help.ts" },
};

function resolveCommand(argv: string[]): { command: string; commandArgs: string[] } {
  const rawArgs = argv.slice(2);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    return { command: "help", commandArgs: [] };
  }
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    return { command: "version", commandArgs: [] };
  }

  const firstPositional = rawArgs.find((arg) => !arg.startsWith("-"));

  if (firstPositional && firstPositional in COMMANDS) {
    const commandIndex = rawArgs.indexOf(firstPositional);
    return {
      command: firstPositional,
      commandArgs: [...rawArgs.slice(0, commandIndex), ...rawArgs.slice(commandIndex + 1)],
    };
  }

  return { command: "start", commandArgs: rawArgs };
}

async function main(): Promise<void> {
  const { command, commandArgs } = resolveCommand(process.argv);

  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`kraken: unknown command '${command}'. Run 'kraken help' for usage.`);
    process.exit(1);
  }

  const mod = (await import(entry.module)) as CommandModule;
  await mod.execute(commandArgs);
}

export { COMMANDS, VERSION };

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
