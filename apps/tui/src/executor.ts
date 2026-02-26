import type { SessionCommandExecutor, SessionCommandDefinition } from "@core/tools/session.ts";
import { ALL_COMMANDS, type SlashCommand, commandRequiresArguments } from "@/commands.ts";
import type { ThreadManager } from "@/threads.ts";

const DESTRUCTIVE_COMMAND_NAMES = new Set(["purge", "delete", "clear"]);

const AGENT_EXCLUDED_COMMANDS = new Set(["continue", "plugins"]);

function toSessionDefinition(command: SlashCommand): SessionCommandDefinition {
  return {
    name: command.name,
    description: command.description,
    requiresArgs: commandRequiresArguments(command),
    destructive: DESTRUCTIVE_COMMAND_NAMES.has(command.name),
  };
}

export function createSessionExecutor(threadManager: ThreadManager): SessionCommandExecutor {
  const exposedCommands = ALL_COMMANDS.filter(
    (command) => !AGENT_EXCLUDED_COMMANDS.has(command.name),
  );

  return {
    listCommands(): SessionCommandDefinition[] {
      return exposedCommands.map(toSessionDefinition);
    },

    async executeCommand(name: string, args: string): Promise<{ success: boolean; output: string }> {
      const command = exposedCommands.find((c) => c.name === name);
      if (!command) {
        return { success: false, output: `unknown command: ${name}` };
      }

      try {
        const result = await command.execute(args, threadManager);
        return { success: true, output: result.output };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: message };
      }
    },
  };
}
