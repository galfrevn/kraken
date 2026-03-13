import { join } from "node:path";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const MAX_READ_CHARACTERS = 32_000;

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description: "Read file contents relative to working directory.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file to read",
        required: true,
      },
      {
        name: "offset",
        type: "number",
        description: "Line number to start reading from (1-based). Default: 1.",
        required: false,
      },
      {
        name: "limit",
        type: "number",
        description: "Maximum number of lines to read. Default: all (capped at ~32K chars).",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = parameters["path"] as string;
    const offset = (parameters["offset"] as number) || 1;
    const limit = parameters["limit"] as number | undefined;
    const absolutePath = join(context.workingDirectory, filePath);
    const file = Bun.file(absolutePath);

    if (!(await file.exists())) {
      return { success: false, output: "", error: `file not found: ${filePath}` };
    }

    let content = await file.text();
    const totalChars = content.length;

    // Apply line offset/limit if specified
    if (offset > 1 || limit !== undefined) {
      const lines = content.split("\n");
      const startLine = Math.max(0, offset - 1);
      const endLine = limit !== undefined ? startLine + limit : lines.length;
      content = lines.slice(startLine, endLine).join("\n");
    }

    // Truncate to character limit
    if (content.length > MAX_READ_CHARACTERS) {
      content = content.slice(0, MAX_READ_CHARACTERS);
      const truncatedNote = `\n\n[truncated — showing ${MAX_READ_CHARACTERS} of ${totalChars} chars. Use offset/limit parameters to read specific sections.]`;
      return { success: true, output: content + truncatedNote };
    }

    return { success: true, output: content };
  },
};
