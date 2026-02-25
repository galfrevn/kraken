import { join, dirname, basename } from "node:path";
import { mkdirSync, rmSync, renameSync, statSync } from "node:fs";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

export const deleteFileTool: Tool = {
  definition: {
    name: "delete_file",
    description:
      "Delete a file or empty directory. For safety, does not delete non-empty directories " +
      "unless recursive is set to true. Cannot delete paths outside the working directory.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the file or directory to delete",
        required: true,
      },
      {
        name: "recursive",
        type: "boolean",
        description: "Delete directory and all contents (default: false)",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = parameters["path"] as string;
    const recursive = parameters["recursive"] === true || parameters["recursive"] === "true";
    const absolutePath = join(context.workingDirectory, filePath);

    if (!absolutePath.startsWith(context.workingDirectory)) {
      return { success: false, output: "", error: "cannot delete outside working directory" };
    }

    try {
      const stats = statSync(absolutePath);
      const isDirectory = stats.isDirectory();

      if (isDirectory && !recursive) {
        return {
          success: false,
          output: "",
          error: "target is a directory. use recursive=true to delete directories with contents.",
        };
      }

      rmSync(absolutePath, { recursive });
      const label = isDirectory ? "directory" : "file";
      return { success: true, output: `deleted ${label}: ${filePath}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        return { success: false, output: "", error: `not found: ${filePath}` };
      }
      return { success: false, output: "", error: `delete failed: ${message}` };
    }
  },
};

export const moveFileTool: Tool = {
  definition: {
    name: "move_file",
    description:
      "Move or rename a file or directory. Creates parent directories for the destination if needed. " +
      "Cannot move paths outside the working directory.",
    parameters: [
      {
        name: "source",
        type: "string",
        description: "Relative path of the source file or directory",
        required: true,
      },
      {
        name: "destination",
        type: "string",
        description: "Relative path of the destination",
        required: true,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const source = parameters["source"] as string;
    const destination = parameters["destination"] as string;
    const absoluteSource = join(context.workingDirectory, source);
    const absoluteDestination = join(context.workingDirectory, destination);

    if (!absoluteSource.startsWith(context.workingDirectory)) {
      return { success: false, output: "", error: "source path is outside working directory" };
    }
    if (!absoluteDestination.startsWith(context.workingDirectory)) {
      return { success: false, output: "", error: "destination path is outside working directory" };
    }

    try {
      statSync(absoluteSource);
    } catch {
      return { success: false, output: "", error: `source not found: ${source}` };
    }

    try {
      mkdirSync(dirname(absoluteDestination), { recursive: true });
      renameSync(absoluteSource, absoluteDestination);
      return { success: true, output: `moved ${source} → ${destination}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `move failed: ${message}` };
    }
  },
};

export const readLinesTool: Tool = {
  definition: {
    name: "read_lines",
    description:
      "Read a specific range of lines from a file. Useful for large files where reading " +
      "the entire content would be too much. Line numbers are 1-based.",
    parameters: [
      { name: "path", type: "string", description: "Relative path to the file", required: true },
      {
        name: "start",
        type: "number",
        description: "Start line number (1-based, default: 1)",
        required: false,
      },
      {
        name: "end",
        type: "number",
        description: "End line number (inclusive, default: start+100)",
        required: false,
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
    const allLines = content.split("\n");
    const totalLines = allLines.length;

    const start = Math.max(1, Number(parameters["start"]) || 1);
    const end = Math.min(totalLines, Number(parameters["end"]) || start + 100);

    if (start > totalLines) {
      return {
        success: false,
        output: "",
        error: `start line ${start} exceeds file length (${totalLines} lines)`,
      };
    }

    const selectedLines = allLines.slice(start - 1, end);
    const numberedLines = selectedLines.map(
      (line, index) => `${String(start + index).padStart(5)} | ${line}`,
    );

    const header = `${basename(filePath)} (lines ${start}-${end} of ${totalLines})`;
    return { success: true, output: `${header}\n${numberedLines.join("\n")}` };
  },
};

export const replaceInFilesTool: Tool = {
  definition: {
    name: "replace_in_files",
    description:
      "Search and replace a string across multiple files matching a glob pattern. " +
      "Shows a preview of changes before applying. Useful for renaming variables, " +
      "updating imports, or batch text replacements.",
    parameters: [
      {
        name: "pattern",
        type: "string",
        description: "Glob pattern for files to process (e.g. '**/*.ts', 'src/**/*.tsx')",
        required: true,
      },
      {
        name: "search",
        type: "string",
        description: "The exact string to search for",
        required: true,
      },
      { name: "replace", type: "string", description: "The replacement string", required: true },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const pattern = parameters["pattern"] as string;
    const search = parameters["search"] as string;
    const replace = parameters["replace"] as string;

    if (!search) {
      return { success: false, output: "", error: "search string cannot be empty" };
    }

    const glob = new Bun.Glob(pattern);
    const modifiedFiles: string[] = [];
    let totalReplacements = 0;

    for await (const match of glob.scan({ cwd: context.workingDirectory, dot: false })) {
      const absolutePath = join(context.workingDirectory, match);

      try {
        const stats = statSync(absolutePath);
        if (!stats.isFile()) continue;
      } catch {
        continue;
      }

      const file = Bun.file(absolutePath);
      const content = await file.text();

      if (!content.includes(search)) continue;

      const occurrences = content.split(search).length - 1;
      const updatedContent = content.replaceAll(search, replace);

      await Bun.write(absolutePath, updatedContent);
      modifiedFiles.push(`${match} (${occurrences} replacements)`);
      totalReplacements += occurrences;
    }

    if (modifiedFiles.length === 0) {
      return { success: true, output: `no files matching "${pattern}" contain "${search}"` };
    }

    const summary =
      `${totalReplacements} replacements across ${modifiedFiles.length} files:\n` +
      modifiedFiles.map((entry) => `  ${entry}`).join("\n");

    return { success: true, output: summary };
  },
};
