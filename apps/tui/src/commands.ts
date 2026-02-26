import type { ThreadManager } from "@/threads.ts";
import type { PluginRegistry } from "@core/plugins/registry.ts";
import { fetchRegistry } from "@core/plugins/installer.ts";

export interface CommandResult {
  output: string;
  switchedThread?: boolean;
  displayMode?: "toast" | "dialog" | "plugin-browser" | "plugin-store";
  data?: unknown;
}

export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  execute(args: string, threadManager: ThreadManager): CommandResult | Promise<CommandResult>;
}

function isSlashCommand(input: string): boolean {
  return input.startsWith("/") && input.length > 1 && input[1] !== " ";
}

function parseSlashInput(input: string): { commandName: string; args: string } | undefined {
  if (!isSlashCommand(input)) return undefined;

  const trimmed = input.slice(1).trim();
  const spaceIndex = trimmed.indexOf(" ");

  if (spaceIndex === -1) {
    return { commandName: trimmed.toLowerCase(), args: "" };
  }

  return {
    commandName: trimmed.slice(0, spaceIndex).toLowerCase(),
    args: trimmed.slice(spaceIndex + 1).trim(),
  };
}

const newThreadCommand: SlashCommand = {
  name: "new",
  aliases: ["n"],
  description: "Start a new conversation thread",
  usage: "/new [title]",
  execute(args, threadManager) {
    const title = args.trim() || undefined;
    const identifier = threadManager.createThread(title);
    threadManager.switchThread(identifier);
    const displayTitle = threadManager.getActiveThreadTitle();
    return {
      output: `started new thread: ${displayTitle}`,
      switchedThread: true,
    };
  },
};

const listThreadsCommand: SlashCommand = {
  name: "threads",
  aliases: ["t", "ls"],
  description: "List all conversation threads",
  usage: "/threads",
  execute(_args, threadManager) {
    const threads = threadManager.listThreads();

    if (threads.length === 0) {
      return { output: "no threads" };
    }

    const lines = threads.map((thread, index) => {
      const activeMarker = thread.active ? " ●" : "  ";
      const messageLabel = thread.messageCount === 1 ? "msg" : "msgs";
      return `${activeMarker} ${index + 1}. ${thread.title}  (${thread.messageCount} ${messageLabel})`;
    });

    return { output: `${threads.length} threads:\n${lines.join("\n")}` };
  },
};

const switchThreadCommand: SlashCommand = {
  name: "switch",
  aliases: ["s", "sw"],
  description: "Switch to another thread by number",
  usage: "/switch <number>",
  execute(args, threadManager) {
    const index = parseInt(args.trim(), 10);

    if (isNaN(index) || index < 1) {
      const threads = threadManager.listThreads();
      const lines = threads.map((thread, i) => {
        const activeMarker = thread.active ? " ●" : "  ";
        return `${activeMarker} ${i + 1}. ${thread.title}`;
      });
      return { output: `usage: /switch <number>\n\n${lines.join("\n")}` };
    }

    const switched = threadManager.switchThreadByIndex(index - 1);
    if (!switched) {
      return { output: `thread ${index} not found. use /threads to see available threads.` };
    }

    const title = threadManager.getActiveThreadTitle();
    return { output: `switched to: ${title}`, switchedThread: true };
  },
};

const clearCommand: SlashCommand = {
  name: "clear",
  aliases: ["c"],
  description: "Clear the current thread's conversation history",
  usage: "/clear",
  execute(_args, threadManager) {
    const engine = threadManager.getActiveEngine();
    engine.clearHistory();
    return { output: "conversation cleared" };
  },
};

const deleteThreadCommand: SlashCommand = {
  name: "delete",
  aliases: ["del", "rm"],
  description: "Delete a thread by number (cannot delete the last remaining thread)",
  usage: "/delete <number>",
  execute(args, threadManager) {
    const index = parseInt(args.trim(), 10);

    if (isNaN(index) || index < 1) {
      return { output: "usage: /delete <number>" };
    }

    const threads = threadManager.listThreads();
    const target = threads[index - 1];

    if (!target) {
      return { output: `thread ${index} not found` };
    }

    if (threads.length <= 1) {
      return { output: "cannot delete the last thread. use /clear instead." };
    }

    const deleted = threadManager.deleteThread(target.identifier);
    if (!deleted) {
      return { output: "could not delete thread" };
    }

    return {
      output: `deleted: ${target.title}`,
      switchedThread: target.active,
    };
  },
};

const renameCommand: SlashCommand = {
  name: "rename",
  aliases: ["title"],
  description: "Rename the current thread",
  usage: "/rename <new title>",
  execute(args, threadManager) {
    const newTitle = args.trim();
    if (!newTitle) {
      return { output: "usage: /rename <new title>" };
    }

    const identifier = threadManager.getActiveThreadIdentifier();
    threadManager.setThreadTitle(identifier, newTitle);
    return { output: `thread renamed to: ${newTitle}` };
  },
};

const continueCommand: SlashCommand = {
  name: "continue",
  aliases: ["cont", "resume"],
  description: "Continue the agent when it reached the iteration limit",
  usage: "/continue",
  execute(_args, threadManager) {
    const engine = threadManager.getActiveEngine();
    if (!engine.hasReachedIterationLimit()) {
      return { output: "nothing to continue — the agent is not paused at an iteration limit" };
    }
    engine.continueFromLimit();
    return { output: "resuming..." };
  },
};

const purgeCommand: SlashCommand = {
  name: "purge",
  aliases: ["reset", "wipe"],
  description: "Delete all threads and messages, starting fresh",
  usage: "/purge",
  execute(_args, threadManager) {
    const previousCount = threadManager.getThreadCount();
    threadManager.purgeAllThreads();
    return {
      output: `purged ${previousCount} thread${previousCount === 1 ? "" : "s"}. starting fresh.`,
      switchedThread: true,
    };
  },
};

export const ALL_COMMANDS: SlashCommand[] = [
  newThreadCommand,
  listThreadsCommand,
  switchThreadCommand,
  clearCommand,
  deleteThreadCommand,
  renameCommand,
  continueCommand,
  purgeCommand,
];

export function registerPluginsCommand(
  pluginRegistry: PluginRegistry,
): void {
  const pluginsCommand: SlashCommand = {
    name: "plugins",
    aliases: ["p", "plugin"],
    description: "Manage installed plugins",
    usage: "/plugins [list|store|inspect|enable|disable] [name]",
    async execute(args) {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "list";
      const pluginName = parts.slice(1).join(" ");

      if (subcommand === "list" || subcommand === "") {
        return { output: "", displayMode: "plugin-browser", data: pluginRegistry };
      }

      if (subcommand === "store" || subcommand === "browse") {
        try {
          const registry = await fetchRegistry();
          return { output: "", displayMode: "plugin-store", data: { registry, pluginRegistry } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { output: `Failed to fetch plugin store: ${message}` };
        }
      }

      if (subcommand === "inspect" || subcommand === "info") {
        if (!pluginName) return { output: "usage: /plugins inspect <name>" };
        return { ...formatPluginInspection(pluginRegistry, pluginName), displayMode: "dialog" };
      }

      if (subcommand === "enable") {
        if (!pluginName) return { output: "usage: /plugins enable <name>" };
        const enabled = await pluginRegistry.enablePlugin(pluginName);
        return enabled
          ? { output: `plugin "${pluginName}" enabled` }
          : { output: `could not enable "${pluginName}" — not found or already active` };
      }

      if (subcommand === "disable") {
        if (!pluginName) return { output: "usage: /plugins disable <name>" };
        const disabled = await pluginRegistry.disablePlugin(pluginName);
        return disabled
          ? { output: `plugin "${pluginName}" disabled` }
          : { output: `could not disable "${pluginName}" — not found or already inactive` };
      }

      return { output: `unknown subcommand: ${subcommand}\nusage: /plugins [list|store|inspect|enable|disable] [name]` };
    },
  };

  ALL_COMMANDS.push(pluginsCommand);
}

function formatPluginInspection(registry: PluginRegistry, name: string): CommandResult {
  const entry = registry.getPluginByName(name);
  if (!entry) {
    return { output: `plugin "${name}" not found` };
  }

  const { plugin, source, enabled, pluginContext } = entry;
  const lines: string[] = [
    `${plugin.name} v${plugin.version}`,
  ];

  if (plugin.description) {
    lines.push(plugin.description);
  }

  if (plugin.author) {
    lines.push(`author: ${plugin.author}`);
  }

  lines.push(`status: ${enabled ? "active" : "disabled"}`);
  lines.push(`source: ${source}`);

  const configKeys = Object.keys(pluginContext.config);
  if (configKeys.length > 0) {
    lines.push("");
    lines.push("config:");
    for (const key of configKeys) {
      lines.push(`  ${key}: ${JSON.stringify(pluginContext.config[key])}`);
    }
  }

  if (plugin.tools && plugin.tools.length > 0) {
    lines.push("");
    lines.push("tools:");
    for (const tool of plugin.tools) {
      const paramList = tool.definition.parameters
        .map((p) => `${p.name}${p.required ? "" : "?"}`)
        .join(", ");
      lines.push(`  → ${tool.definition.name}(${paramList})`);
      lines.push(`    ${tool.definition.description}`);
    }
  }

  if (plugin.hooks) {
    const hookNames = Object.keys(plugin.hooks).filter(
      (key) => typeof (plugin.hooks as Record<string, unknown>)[key] === "function",
    );
    if (hookNames.length > 0) {
      lines.push("");
      lines.push(`hooks: ${hookNames.join(", ")}`);
    }
  }

  if (plugin.promptExtension) {
    lines.push("");
    lines.push(`prompt extension: "${plugin.promptExtension.slice(0, 80)}${plugin.promptExtension.length > 80 ? "..." : ""}"`);
  }

  return { output: lines.join("\n") };
}

function findCommand(name: string): SlashCommand | undefined {
  return ALL_COMMANDS.find(
    (command) => command.name === name || command.aliases.includes(name),
  );
}

export function commandRequiresArguments(command: SlashCommand): boolean {
  return command.usage.includes("<");
}

export async function handleSlashCommand(
  input: string,
  threadManager: ThreadManager,
): Promise<CommandResult | undefined> {
  const parsed = parseSlashInput(input);
  if (!parsed) return undefined;

  const command = findCommand(parsed.commandName);
  if (!command) {
    return { output: `unknown command: /${parsed.commandName}. type /help for available commands.` };
  }

  return command.execute(parsed.args, threadManager);
}
