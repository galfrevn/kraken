import { join } from "node:path";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

export const editFileTool: Tool = {
  definition: {
    name: "edit_file",
    description: "Replace an exact string in a file. old_string must be unique.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file to edit",
        required: true,
      },
      {
        name: "old_string",
        type: "string",
        description: "The exact string to find and replace (must be unique in the file)",
        required: true,
      },
      { name: "new_string", type: "string", description: "The replacement string", required: true },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = parameters["path"] as string;
    const oldString = parameters["old_string"] as string;
    const newString = parameters["new_string"] as string;
    const absolutePath = join(context.workingDirectory, filePath);

    const file = Bun.file(absolutePath);
    if (!(await file.exists())) {
      return { success: false, output: "", error: `file not found: ${filePath}` };
    }

    const content = await file.text();

    if (!oldString) {
      return { success: false, output: "", error: "old_string cannot be empty" };
    }

    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      const preview = oldString.length > 80 ? oldString.slice(0, 80) + "..." : oldString;
      return {
        success: false,
        output: "",
        error: `old_string not found in ${filePath}: "${preview}"`,
      };
    }

    if (occurrences > 1) {
      return {
        success: false,
        output: "",
        error: `old_string matches ${occurrences} locations in ${filePath}. Provide more context to make it unique.`,
      };
    }

    const updatedContent = content.replace(oldString, newString);
    await Bun.write(absolutePath, updatedContent);

    const removedLines = oldString.split(/\r?\n/).length;
    const addedLines = newString.split(/\r?\n/).length;

    return {
      success: true,
      output: `edited ${filePath}: -${removedLines} lines, +${addedLines} lines`,
    };
  },
};
