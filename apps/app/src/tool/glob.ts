import { z } from "zod";
import { Glob } from "bun";
import { resolve } from "node:path";
import { defineTool } from "@/tool/tool.ts";
import { toolResultCache } from "@/cache/index.ts";

const MAX_GLOB_RESULTS = 200;

export const globTool = defineTool({
  id: "glob",
  description:
    "Find files matching a glob pattern. Returns file paths sorted by modification time.",
  parameters: z.object({
    pattern: z.string().describe("Glob pattern (e.g., '**/*.ts', 'src/**/*.tsx')"),
    path: z.string().optional().describe("Directory to search in (default: working directory)"),
  }),
  async execute(args, context) {
    const searchDirectory = resolve(context.workingDirectory, args.path ?? ".");

    const cached = toolResultCache.get("glob", args);
    if (cached) {
      return { ...cached, metadata: { ...cached.metadata, cached: true } };
    }

    const globInstance = new Glob(args.pattern);

    const matchingPaths: string[] = [];
    for await (const matchedPath of globInstance.scan({ cwd: searchDirectory, dot: false })) {
      if (context.abortSignal.aborted) break;
      matchingPaths.push(matchedPath);
      if (matchingPaths.length >= MAX_GLOB_RESULTS) break;
    }

    const resultText = matchingPaths.length > 0 ? matchingPaths.join("\n") : "No files matched.";

    const result = {
      title: `glob: ${args.pattern}`,
      content: resultText,
      metadata: { matchCount: matchingPaths.length },
    };
    toolResultCache.set("glob", args, result, [searchDirectory]);
    return result;
  },
});
