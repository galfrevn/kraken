import { join } from "node:path";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description:
      "Read the contents of a file at the given path, relative to the working directory.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file to read",
        required: true,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = parameters["path"] as string;
    const absolutePath = join(context.workingDirectory, filePath);
    const file = Bun.file(absolutePath);

    if (!(await file.exists())) {
      return { success: false, output: "", error: `file not found: ${filePath}` };
    }

    const content = await file.text();
    return { success: true, output: content };
  },
};
