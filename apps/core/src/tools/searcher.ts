import { spawnCommand } from "@/tools/spawn.ts";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const MAX_RESULT_LINES = 100;

export const searchFilesTool: Tool = {
  definition: {
    name: "search_files",
    description: "Search for a text pattern in files using ripgrep.",
    parameters: [
      {
        name: "pattern",
        type: "string",
        description: "The search pattern (supports regex)",
        required: true,
      },
      {
        name: "path",
        type: "string",
        description: "Relative path to search in (default: '.')",
        required: false,
      },
      {
        name: "glob",
        type: "string",
        description: "File glob pattern to filter (e.g. '*.ts', '*.py')",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const pattern = parameters["pattern"] as string;
    const searchPath = (parameters["path"] as string) || ".";
    const glob = parameters["glob"] as string | undefined;

    const args = ["--line-number", "--no-heading", "--max-count=50"];

    if (glob) {
      args.push(`--glob=${glob}`);
    }

    args.push(pattern, searchPath);

    try {
      const result = await spawnCommand("rg", args, context.workingDirectory);

      if (result.exitCode === 1) {
        return { success: true, output: "no matches found" };
      }

      if (result.exitCode !== 0) {
        return { success: false, output: "", error: `search failed: ${result.stderr}` };
      }

      const lines = result.stdout.split(/\r?\n/);
      const truncatedOutput =
        lines.length > MAX_RESULT_LINES
          ? lines.slice(0, MAX_RESULT_LINES).join("\n") +
            `\n... (${lines.length - MAX_RESULT_LINES} more matches)`
          : result.stdout;

      return { success: true, output: truncatedOutput || "no matches found" };
    } catch (executionError) {
      const message =
        executionError instanceof Error ? executionError.message : String(executionError);
      return { success: false, output: "", error: `search failed: ${message}` };
    }
  },
};
