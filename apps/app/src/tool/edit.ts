import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { defineTool } from "@/tool/tool.ts";
import { isBlockedFilePath, BLOCKED_FILE_ACCESS_MESSAGE } from "@/tool/security.ts";
import { fileCache, toolResultCache } from "@/cache/index.ts";
import { createUnifiedDiff } from "@/util/diff.ts";

export const editTool = defineTool({
  id: "edit",
  description:
    "Edit a file by replacing an exact string with a new string. The old_string must match exactly (including whitespace and indentation).",
  parameters: z.object({
    filePath: z.string().describe("Path to the file to edit"),
    oldString: z.string().describe("The exact text to find and replace"),
    newString: z.string().describe("The replacement text"),
  }),
  async execute(args, context) {
    const absolutePath = resolve(context.workingDirectory, args.filePath);

    if (isBlockedFilePath(absolutePath)) {
      return { title: args.filePath, content: BLOCKED_FILE_ACCESS_MESSAGE };
    }

    if (!existsSync(absolutePath)) {
      return { title: args.filePath, content: `Error: file not found: ${absolutePath}` };
    }

    const originalContent = readFileSync(absolutePath, "utf-8");
    const matchCount = originalContent.split(args.oldString).length - 1;

    if (matchCount === 0) {
      return {
        title: args.filePath,
        content: `Error: old_string not found in ${args.filePath}. Make sure the string matches exactly.`,
      };
    }
    if (matchCount > 1) {
      return {
        title: args.filePath,
        content: `Error: old_string found ${matchCount} times in ${args.filePath}. It must be unique. Add more surrounding context.`,
      };
    }

    const updatedContent = originalContent.replace(args.oldString, args.newString);
    writeFileSync(absolutePath, updatedContent, "utf-8");

    fileCache.invalidate(absolutePath);
    toolResultCache.invalidateByPath(absolutePath);

    const diff = createUnifiedDiff(args.filePath, originalContent, updatedContent);

    return {
      title: `Edited ${args.filePath}`,
      content: `Replaced 1 occurrence in ${absolutePath}\n<!--diff:${extname(args.filePath).slice(1)}-->\n${diff}\n<!--/diff-->`,
      metadata: { path: absolutePath },
    };
  },
});
