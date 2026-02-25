import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

export const writeFileTool: Tool = {
  definition: {
    name: "write_file",
    description:
      "Write content to a file at the given path, relative to the working directory. Creates parent directories if needed.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file to write",
        required: true,
      },
      {
        name: "content",
        type: "string",
        description: "Content to write to the file",
        required: true,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = parameters["path"] as string;
    const content = parameters["content"] as string;
    const absolutePath = join(context.workingDirectory, filePath);

    mkdirSync(dirname(absolutePath), { recursive: true });
    await Bun.write(absolutePath, content);

    return { success: true, output: `wrote ${content.length} characters to ${filePath}` };
  },
};
