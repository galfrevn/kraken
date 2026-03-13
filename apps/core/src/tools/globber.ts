import { join } from "node:path";
import { Glob } from "bun";
import { statSync } from "node:fs";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const MAX_RESULTS = 200;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const globFilesTool: Tool = {
  definition: {
    name: "glob_files",
    description: "Find files matching a glob pattern.",
    parameters: [
      {
        name: "pattern",
        type: "string",
        description: "Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.tsx')",
        required: true,
      },
      {
        name: "path",
        type: "string",
        description: "Relative base path to search from (default: '.')",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const pattern = parameters["pattern"] as string;
    const basePath = (parameters["path"] as string) || ".";
    const absoluteBase = join(context.workingDirectory, basePath);

    try {
      const glob = new Glob(pattern);
      const results: string[] = [];

      for await (const match of glob.scan({ cwd: absoluteBase, dot: false })) {
        if (results.length >= MAX_RESULTS) break;

        try {
          const stats = statSync(join(absoluteBase, match));
          if (stats.isFile()) {
            results.push(`${match}  (${formatFileSize(stats.size)})`);
          }
        } catch {
          results.push(match);
        }
      }

      if (results.length === 0) {
        return { success: true, output: `no files matching "${pattern}"` };
      }

      results.sort();

      let output = `${results.length} files matching "${pattern}"`;
      if (results.length >= MAX_RESULTS) {
        output += ` (showing first ${MAX_RESULTS})`;
      }
      output += ":\n" + results.join("\n");

      return { success: true, output };
    } catch (globError) {
      const message = globError instanceof Error ? globError.message : String(globError);
      return { success: false, output: "", error: `glob failed: ${message}` };
    }
  },
};
