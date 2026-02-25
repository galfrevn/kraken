import { SubagentRunner } from "@/agent/subagent.ts";
import { ToolRegistry } from "@/tools/registry.ts";
import type { LanguageModelClient } from "@/language/client.ts";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

export function createDelegateTool(
  languageModelClient: LanguageModelClient,
  parentRegistry: ToolRegistry,
  defaultWorkingDirectory: string,
): Tool {
  return {
    definition: {
      name: "delegate",
      description:
        "Delegate a task to a subagent with a clean context. " +
        "The subagent gets its own conversation history and can use all tools. " +
        "Use this for self-contained tasks that don't need the current conversation context, " +
        "repetitive multi-file operations, or research tasks. " +
        "Optionally specify a faster model for simple tasks.",
      parameters: [
        {
          name: "task",
          type: "string",
          description:
            "Detailed description of what the subagent should accomplish. " +
            "Include file paths, expected outcomes, and step-by-step directions.",
          required: true,
        },
        {
          name: "model",
          type: "string",
          description:
            "Model to use for the subagent (e.g. 'deepseek/deepseek-v3' for fast tasks). " +
            "Omit to use the current model.",
          required: false,
        },
        {
          name: "context",
          type: "string",
          description:
            "Additional context to pass to the subagent, such as file contents or prior findings.",
          required: false,
        },
      ],
    },

    async execute(
      parameters: Record<string, unknown>,
      executionContext: ToolExecutionContext,
    ): Promise<ToolResult> {
      const task = parameters["task"] as string;
      const model = parameters["model"] as string | undefined;
      const context = parameters["context"] as string | undefined;

      const childRegistry = new ToolRegistry();
      for (const tool of parentRegistry.listTools()) {
        if (tool.definition.name === "delegate") continue;
        childRegistry.register(tool);
      }

      const workingDirectory = executionContext.workingDirectory || defaultWorkingDirectory;

      const subagent = new SubagentRunner(languageModelClient, childRegistry, workingDirectory);

      const result = await subagent.execute({ task, model, context });

      const summary = result.success ? result.output : `subagent failed: ${result.output}`;

      const metadata = `[${result.iterations} iterations, ${result.toolCalls} tool calls]`;

      return {
        success: result.success,
        output: `${summary}\n\n${metadata}`,
        error: result.success ? undefined : result.output,
      };
    },
  };
}
