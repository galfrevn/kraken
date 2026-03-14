import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";
import { resolve, isAbsolute } from "node:path";

const IS_WINDOWS = process.platform === "win32";

let pdfParseAvailable = false;
let pdfParseModule: any = null;

async function runShell(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = IS_WINDOWS ? ["cmd", "/c", ...args] : args;
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function resolvePath(path: string, workingDirectory: string): string {
  return isAbsolute(path) ? path : resolve(workingDirectory, path);
}

async function tryLoadPdfParse(): Promise<boolean> {
  try {
    pdfParseModule = await import("pdf-parse" as string);
    pdfParseAvailable = true;
    return true;
  } catch {
    pdfParseAvailable = false;
    pdfParseModule = null;
    return false;
  }
}

/**
 * Fallback text extraction when pdf-parse is unavailable.
 * Reads the PDF as text and extracts readable strings from content streams.
 * This is a best-effort approach that won't handle all PDFs perfectly.
 */
function extractTextFallback(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const extracted: string[] = [];

  // Extract strings in parentheses (PDF literal strings in content streams)
  const parenRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = parenRegex.exec(raw)) !== null) {
    const str = match[1]!
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
    // Filter out non-printable / binary noise
    const printable = str.replace(/[^\x20-\x7E\n\r\t]/g, "");
    if (printable.length > 1) {
      extracted.push(printable);
    }
  }

  // Extract hex strings between angle brackets
  const hexRegex = /<([0-9A-Fa-f\s]+)>/g;
  while ((match = hexRegex.exec(raw)) !== null) {
    const hex = match[1]!.replace(/\s/g, "");
    if (hex.length >= 4 && hex.length % 2 === 0) {
      let decoded = "";
      for (let i = 0; i < hex.length; i += 2) {
        const charCode = parseInt(hex.substring(i, i + 2), 16);
        if (charCode >= 0x20 && charCode <= 0x7e) {
          decoded += String.fromCharCode(charCode);
        }
      }
      if (decoded.length > 1) {
        extracted.push(decoded);
      }
    }
  }

  if (extracted.length === 0) {
    return "[No text could be extracted. The PDF may be image-based or encrypted. Run pdf_setup to install pdf-parse for better extraction.]";
  }

  // Deduplicate consecutive identical strings and join
  const deduplicated: string[] = [];
  for (const s of extracted) {
    if (deduplicated.length === 0 || deduplicated[deduplicated.length - 1] !== s) {
      deduplicated.push(s);
    }
  }

  return deduplicated.join(" ");
}

/**
 * Extract basic PDF metadata from the binary without pdf-parse.
 */
function extractMetadataFallback(buffer: Buffer): Record<string, string> {
  const raw = buffer.toString("latin1");
  const meta: Record<string, string> = {};

  // Count pages: look for /Type /Page (not /Pages)
  const pageMatches = raw.match(/\/Type\s*\/Page(?!\s*s)/g);
  meta["pages"] = pageMatches ? String(pageMatches.length) : "unknown";

  // Extract info dict fields
  const fields = ["Title", "Author", "Subject", "Creator", "Producer", "CreationDate", "ModDate"];
  for (const field of fields) {
    const regex = new RegExp(`/${field}\\s*\\(([^)]*?)\\)`);
    const m = raw.match(regex);
    if (m) {
      meta[field.toLowerCase()] = m[1]!;
    }
  }

  // PDF version from header
  const versionMatch = raw.match(/%PDF-(\d+\.\d+)/);
  if (versionMatch) {
    meta["pdf_version"] = versionMatch[1]!;
  }

  return meta;
}

const pdfReadTool: Tool = {
  definition: {
    name: "pdf_read",
    description:
      "Read and extract text content from a PDF file. " +
      "Returns the full text or a specific page range. " +
      "If extraction quality is poor, run pdf_setup first to install the pdf-parse library.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Path to the PDF file (absolute or relative to working directory).",
        required: true,
      },
      {
        name: "pages",
        type: "string",
        description:
          'Optional page range to extract, e.g. "1-5" or "3". Only works when pdf-parse is installed.',
        required: false,
      },
    ],
  },
  async execute(parameters, context): Promise<ToolResult> {
    const pathParam = parameters["path"] as string;
    if (!pathParam) {
      return { success: false, output: "path parameter is required" };
    }

    const filePath = resolvePath(pathParam, context.workingDirectory);
    const pagesParam = parameters["pages"] as string | undefined;

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) {
        return { success: false, output: `File not found: ${filePath}` };
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      // Try pdf-parse first
      if (pdfParseAvailable && pdfParseModule) {
        try {
          const pdfParse = pdfParseModule.default ?? pdfParseModule;
          const options: Record<string, unknown> = {};

          if (pagesParam) {
            // Parse page range
            const rangeMatch = pagesParam.match(/^(\d+)(?:-(\d+))?$/);
            if (rangeMatch) {
              const start = parseInt(rangeMatch[1]!, 10);
              const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start;
              options.max = end;
              options.pagerender = function (pageData: any) {
                const pageNum = pageData.pageIndex + 1;
                if (pageNum >= start && pageNum <= end) {
                  return pageData.getTextContent().then((content: any) => {
                    return content.items.map((item: any) => item.str).join(" ");
                  });
                }
                return Promise.resolve("");
              };
            }
          }

          const data = await pdfParse(buffer, options);
          const text = data.text?.trim();
          if (!text) {
            return {
              success: true,
              output: "[PDF parsed but no text content found. The file may be image-based.]",
            };
          }

          const header = `[PDF: ${data.numpages} page(s)]`;
          const pageInfo = pagesParam ? ` [Showing pages: ${pagesParam}]` : "";
          return { success: true, output: `${header}${pageInfo}\n\n${text}` };
        } catch (parseError) {
          // Fall through to fallback
          const msg = parseError instanceof Error ? parseError.message : String(parseError);
          console.log(`[pdf] pdf-parse failed (${msg}), using fallback extraction`);
        }
      }

      // Fallback extraction
      const text = extractTextFallback(buffer);
      const meta = extractMetadataFallback(buffer);
      const header = `[PDF: ${meta["pages"]} page(s), fallback extraction — run pdf_setup for better results]`;
      return { success: true, output: `${header}\n\n${text}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read PDF: ${message}` };
    }
  },
};

const pdfInfoTool: Tool = {
  definition: {
    name: "pdf_info",
    description: "Get metadata from a PDF file (page count, title, author, creation date, etc.).",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Path to the PDF file (absolute or relative to working directory).",
        required: true,
      },
    ],
  },
  async execute(parameters, context): Promise<ToolResult> {
    const pathParam = parameters["path"] as string;
    if (!pathParam) {
      return { success: false, output: "path parameter is required" };
    }

    const filePath = resolvePath(pathParam, context.workingDirectory);

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) {
        return { success: false, output: `File not found: ${filePath}` };
      }

      const buffer = Buffer.from(await file.arrayBuffer());

      // Try pdf-parse for rich metadata
      if (pdfParseAvailable && pdfParseModule) {
        try {
          const pdfParse = pdfParseModule.default ?? pdfParseModule;
          const data = await pdfParse(buffer);
          const info: Record<string, string> = {
            pages: String(data.numpages ?? "unknown"),
            pdf_version: data.version ?? "unknown",
          };

          if (data.info) {
            for (const [key, value] of Object.entries(data.info)) {
              if (value && typeof value === "string") {
                info[key.toLowerCase()] = value;
              }
            }
          }

          if (data.metadata) {
            try {
              const meta = data.metadata.getAll?.() ?? {};
              for (const [key, value] of Object.entries(meta)) {
                if (value && typeof value === "string") {
                  info[key.toLowerCase()] = value;
                }
              }
            } catch {
              /* metadata parsing can fail on some PDFs */
            }
          }

          const lines = Object.entries(info).map(([k, v]) => `  ${k}: ${v}`);
          return { success: true, output: `PDF Metadata (${filePath}):\n${lines.join("\n")}` };
        } catch (parseError) {
          const msg = parseError instanceof Error ? parseError.message : String(parseError);
          console.log(`[pdf] pdf-parse failed (${msg}), using fallback metadata`);
        }
      }

      // Fallback metadata extraction
      const meta = extractMetadataFallback(buffer);
      const lines = Object.entries(meta).map(([k, v]) => `  ${k}: ${v}`);
      const header = "[Fallback extraction — run pdf_setup for richer metadata]";
      return {
        success: true,
        output: `PDF Metadata (${filePath}):\n${header}\n${lines.join("\n")}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read PDF info: ${message}` };
    }
  },
};

const pdfSetupTool: Tool = {
  definition: {
    name: "pdf_setup",
    description:
      "Install pdf-parse globally for high-quality PDF text extraction. " +
      "Run this once if pdf_read returns poor results.",
    parameters: [],
  },
  async execute(): Promise<ToolResult> {
    try {
      const result = await runShell(["bun", "i", "-g", "pdf-parse"]);
      if (result.exitCode !== 0) {
        return {
          success: false,
          output: `Failed to install pdf-parse: ${result.stderr || result.stdout}`,
        };
      }

      // Try loading the module after install
      const loaded = await tryLoadPdfParse();
      if (loaded) {
        return {
          success: true,
          output:
            "pdf-parse installed and loaded successfully. PDF extraction quality will now be improved.",
        };
      }

      return {
        success: true,
        output:
          "pdf-parse installed. It will be available after reloading the plugin. " +
          `Install output: ${result.stdout}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to install pdf-parse: ${message}` };
    }
  },
};

export default definePlugin({
  name: "pdf",
  version: "0.1.0",
  description:
    "Read and extract text and metadata from PDF files. " +
    "Uses pdf-parse when available, falls back to basic binary extraction.",
  author: "kraken",

  toolDisplayNames: {
    pdf_read: "Read PDF",
    pdf_info: "PDF Info",
    pdf_setup: "Setup PDF Parser",
  },

  tools: [pdfReadTool, pdfInfoTool, pdfSetupTool],

  promptExtension:
    "You have PDF tools from the 'pdf' plugin. " +
    "Use pdf_read to extract text content from PDF files and pdf_info to get metadata (page count, title, author). " +
    "If the extracted text quality is poor or the output suggests fallback mode, " +
    "run pdf_setup once to install the pdf-parse library for significantly better extraction. " +
    "After setup, pdf_read will automatically use the improved parser.",

  activate: async () => {
    await tryLoadPdfParse();
    if (pdfParseAvailable) {
      console.log("[pdf] activated (pdf-parse available)");
    } else {
      console.log("[pdf] activated (fallback mode — run pdf_setup for better extraction)");
    }
  },

  deactivate: async () => {
    pdfParseModule = null;
    pdfParseAvailable = false;
    console.log("[pdf] deactivated");
  },
});
