import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { defineTool } from "@/tool/tool.ts";
import { isBlockedFilePath, BLOCKED_FILE_ACCESS_MESSAGE } from "@/tool/security.ts";
import { fileCache, toolResultCache } from "@/cache/index.ts";

export const writeTool = defineTool({
  id: "write",
  description:
    "Write content to a file. Creates the file and any parent directories if they don't exist. Overwrites existing content.",
  parameters: z.object({
    filePath: z.string().describe("Absolute or relative path to the file"),
    content: z.string().describe("The content to write"),
  }),
  async execute(args, context) {
    const absolutePath = resolve(context.workingDirectory, args.filePath);

    if (isBlockedFilePath(absolutePath)) {
      return { title: args.filePath, content: BLOCKED_FILE_ACCESS_MESSAGE };
    }

    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, args.content, "utf-8");

    fileCache.invalidate(absolutePath);
    toolResultCache.invalidateByPath(absolutePath);

    const lineCount = args.content.split("\n").length;
    return {
      title: `Wrote ${args.filePath}`,
      content: `Written ${lineCount} lines to ${absolutePath}`,
      metadata: { path: absolutePath, lineCount },
    };
  },
});
