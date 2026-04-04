import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineTool } from "@/tool/tool.ts";
import { isBlockedFilePath, BLOCKED_FILE_ACCESS_MESSAGE } from "@/tool/security.ts";
import { fileCache } from "@/cache/index.ts";

const LINE_NUMBER_PADDING_WIDTH = 6;

function formatLines(rawContent: string, offset?: number, limit?: number) {
  const allLines = rawContent.split("\n");
  const startLine = (offset ?? 1) - 1;
  const endLine = limit ? startLine + limit : allLines.length;
  const selectedLines = allLines.slice(startLine, endLine);

  const numberedLines = selectedLines
    .map(
      (line, lineIndex) =>
        `${String(startLine + lineIndex + 1).padStart(LINE_NUMBER_PADDING_WIDTH)}  ${line}`,
    )
    .join("\n");

  return { numberedLines, totalLines: allLines.length };
}

export const readTool = defineTool({
  id: "read",
  description: "Read the contents of a file. Returns the file content with line numbers.",
  parameters: z.object({
    filePath: z.string().describe("Absolute or relative path to the file"),
    offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
  }),
  async execute(args, context) {
    const absolutePath = resolve(context.workingDirectory, args.filePath);

    if (isBlockedFilePath(absolutePath)) {
      return { title: args.filePath, content: BLOCKED_FILE_ACCESS_MESSAGE };
    }

    if (!existsSync(absolutePath)) {
      return { title: args.filePath, content: `Error: file not found: ${absolutePath}` };
    }

    const cached = fileCache.get(absolutePath);
    if (cached) {
      const { numberedLines, totalLines } = formatLines(cached, args.offset, args.limit);
      return {
        title: args.filePath,
        content: numberedLines,
        metadata: { totalLines, cached: true },
      };
    }

    const rawContent = readFileSync(absolutePath, "utf-8");
    const mtimeMs = statSync(absolutePath).mtimeMs;
    fileCache.set(absolutePath, rawContent, mtimeMs);

    const { numberedLines, totalLines } = formatLines(rawContent, args.offset, args.limit);

    return {
      title: args.filePath,
      content: numberedLines,
      metadata: { totalLines },
    };
  },
});
