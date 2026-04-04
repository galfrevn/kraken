import { z } from "zod";
import { spawn } from "bun";
import { resolve } from "node:path";
import { defineTool } from "@/tool/tool.ts";
import { toolResultCache } from "@/cache/index.ts";

const MAX_GREP_RESULTS = 100;

export const grepTool = defineTool({
  id: "grep",
  description: "Search file contents using a regex pattern. Requires ripgrep (rg).",
  parameters: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("File or directory to search in"),
    include: z.string().optional().describe("File glob filter (e.g., '*.ts')"),
  }),
  async execute(args, context) {
    const searchPath = resolve(context.workingDirectory, args.path ?? ".");

    const cached = toolResultCache.get("grep", args);
    if (cached) {
      return { ...cached, metadata: { ...cached.metadata, cached: true } };
    }

    const ripgrepArguments = [
      "rg",
      "--line-number",
      "--no-heading",
      "--max-count",
      String(MAX_GREP_RESULTS),
    ];
    if (args.include) {
      ripgrepArguments.push("--glob", args.include);
    }
    ripgrepArguments.push(args.pattern, searchPath);

    try {
      const childProcess = spawn({
        cmd: ripgrepArguments,
        stdout: "pipe",
        stderr: "pipe",
        cwd: context.workingDirectory,
      });

      const abortHandler = () => childProcess.kill();
      context.abortSignal.addEventListener("abort", abortHandler, { once: true });
      await childProcess.exited;
      context.abortSignal.removeEventListener("abort", abortHandler);
      const outputText = await new Response(childProcess.stdout).text();

      if (!outputText.trim()) {
        return { title: `grep: ${args.pattern}`, content: "No matches found." };
      }

      const result = { title: `grep: ${args.pattern}`, content: outputText.trim() };
      toolResultCache.set("grep", args, result, [searchPath]);
      return result;
    } catch {
      return {
        title: `grep: ${args.pattern}`,
        content: "Error: rg (ripgrep) not found. Install it or use bash tool.",
      };
    }
  },
});
