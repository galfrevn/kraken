import type { Tool, ToolResult } from "@/tools/schema.ts";

export interface SessionCommandDefinition {
  name: string;
  description: string;
  requiresArgs: boolean;
  destructive: boolean;
}

export interface SessionCommandExecutor {
  listCommands(): SessionCommandDefinition[];
  executeCommand(name: string, args: string): Promise<{ success: boolean; output: string }>;
}

export function createSessionCommandTool(executor: SessionCommandExecutor): Tool {
  const commandList = executor.listCommands();

  return {
    definition: {
      name: "session_command",
      description: "Execute a session command. Commands: new, clear, delete, purge, rename, threads.",
      requiresConfirmation: true,
      parameters: [
        {
          name: "command",
          type: "string" as const,
          description:
            "The command name to execute (e.g. 'new', 'clear', 'delete', 'purge', 'rename', 'threads').",
          required: true,
        },
        {
          name: "args",
          type: "string" as const,
          description:
            "Arguments for the command (e.g. thread number for /delete, title for /rename).",
          required: false,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const commandName = ((parameters["command"] as string) ?? "").toLowerCase().trim();
      const args = (parameters["args"] as string) ?? "";

      if (!commandName) {
        return {
          success: false,
          output: "",
          error:
            "command name is required. Available: " + commandList.map((c) => c.name).join(", "),
        };
      }

      const commandDefinition = commandList.find((c) => c.name === commandName);
      if (!commandDefinition) {
        return {
          success: false,
          output: "",
          error: `unknown command "${commandName}". Available: ${commandList.map((c) => c.name).join(", ")}`,
        };
      }

      const result = await executor.executeCommand(commandName, args);

      return {
        success: result.success,
        output: result.output,
        error: result.success ? undefined : result.output,
      };
    },
  };
}
