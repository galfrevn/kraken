import { join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const MAX_ENTRIES = 500;

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  "__pycache__",
  ".cache",
  "coverage",
]);

function collectEntries(
  directoryPath: string,
  basePath: string,
  maxDepth: number,
  currentDepth: number,
  results: string[],
): void {
  if (results.length >= MAX_ENTRIES) return;

  let entries: string[];
  try {
    entries = readdirSync(directoryPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_ENTRIES) return;

    const entryPath = join(directoryPath, entry);
    const displayPath = relative(basePath, entryPath);

    try {
      const stats = statSync(entryPath);

      if (stats.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;

        results.push(`dir  ${displayPath}/`);

        if (currentDepth < maxDepth) {
          collectEntries(entryPath, basePath, maxDepth, currentDepth + 1, results);
        }
      } else {
        const sizeLabel = ` (${formatFileSize(stats.size)})`;
        results.push(`file ${displayPath}${sizeLabel}`);
      }
    } catch {
      results.push(`?    ${displayPath}`);
    }
  }
}

export const listDirectoryTool: Tool = {
  definition: {
    name: "list_directory",
    description:
      "List files and directories at the given path. Shows type (file/dir), relative path, and size. " +
      "Use the depth parameter to list subdirectories recursively (default: 1, max: 5). " +
      "Common directories like node_modules, .git, dist are excluded from recursive listing.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the directory to list (default: '.')",
        required: false,
      },
      {
        name: "depth",
        type: "number",
        description:
          "How many levels deep to recurse into subdirectories (default: 1, max: 5). Use 1 for current directory only.",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = (parameters["path"] as string) || ".";
    const absolutePath = join(context.workingDirectory, relativePath);
    const requestedDepth = Number(parameters["depth"]) || 1;
    const maxDepth = Math.min(Math.max(requestedDepth, 1), 5);

    try {
      const results: string[] = [];
      collectEntries(absolutePath, absolutePath, maxDepth, 1, results);

      if (results.length >= MAX_ENTRIES) {
        results.push(`\n... truncated at ${MAX_ENTRIES} entries (increase depth cautiously)`);
      }

      const header =
        maxDepth > 1 ? `listing ${relativePath} (depth: ${maxDepth}):` : `listing ${relativePath}:`;

      return {
        success: true,
        output: results.length > 0 ? header + "\n" + results.join("\n") : "(empty directory)",
      };
    } catch {
      return { success: false, output: "", error: `cannot list directory: ${relativePath}` };
    }
  },
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
