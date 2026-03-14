import { existsSync } from "node:fs";
import { join, isAbsolute, extname } from "node:path";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const SUPPORTED_FORMATS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"]);

export const viewImageTool: Tool = {
  definition: {
    name: "view_image",
    description: "View and analyze an image file. Returns metadata and encoded data.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative or absolute path to the image file",
        required: true,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const rawPath = parameters["path"] as string;

    if (!rawPath) {
      return { success: false, output: "", error: "path parameter is required" };
    }

    const filePath = isAbsolute(rawPath) ? rawPath : join(context.workingDirectory, rawPath);

    if (!existsSync(filePath)) {
      return { success: false, output: "", error: `file not found: ${rawPath}` };
    }

    const ext = extname(filePath).toLowerCase();

    if (!SUPPORTED_FORMATS.has(ext)) {
      return {
        success: false,
        output: "",
        error: `unsupported image format: ${ext} (supported: ${[...SUPPORTED_FORMATS].join(", ")})`,
      };
    }

    try {
      const file = Bun.file(filePath);
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64 = buffer.toString("base64");
      const sizeKB = (buffer.byteLength / 1024).toFixed(1);
      const format = ext.replace(".", "").toUpperCase();

      let dimensions = "";

      if (ext === ".png" && buffer.length >= 24) {
        // PNG IHDR: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        if (width > 0 && height > 0 && width < 100000 && height < 100000) {
          dimensions = ` ${width}x${height}`;
        }
      }

      const output = `[Image: ${format}${dimensions} (${sizeKB} KB)]\npath: ${filePath}\nbase64:${base64}`;

      return { success: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: `failed to read image: ${message}` };
    }
  },
};
