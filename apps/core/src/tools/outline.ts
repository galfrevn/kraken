import { join, extname } from "node:path";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const MAX_OUTPUT_LINES = 300;

interface SymbolEntry {
  kind: string;
  name: string;
  line: number;
  indent: number;
}

const EXTRACTORS: Record<string, (lines: string[]) => SymbolEntry[]> = {
  ".ts": extractTypeScriptSymbols,
  ".tsx": extractTypeScriptSymbols,
  ".js": extractTypeScriptSymbols,
  ".jsx": extractTypeScriptSymbols,
  ".py": extractPythonSymbols,
  ".go": extractGoSymbols,
  ".rs": extractRustSymbols,
  ".rb": extractRubySymbols,
};

export const codeOutlineTool: Tool = {
  definition: {
    name: "code_outline",
    description: "Extract structural outline (functions, classes, types) from a source file.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Relative path to the source file",
        required: true,
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

    const extension = extname(filePath).toLowerCase();
    const extractor = EXTRACTORS[extension];

    if (!extractor) {
      const supported = Object.keys(EXTRACTORS).join(", ");
      return {
        success: false,
        output: "",
        error: `unsupported file type: ${extension}. supported: ${supported}`,
      };
    }

    const content = await file.text();
    const lines = content.split("\n");
    const symbols = extractor(lines);

    if (symbols.length === 0) {
      return { success: true, output: `${filePath}: no symbols found (${lines.length} lines)` };
    }

    const formatted = symbols.map((symbol) => {
      const padding = "  ".repeat(symbol.indent);
      return `${String(symbol.line).padStart(5)} | ${padding}${symbol.kind} ${symbol.name}`;
    });

    if (formatted.length > MAX_OUTPUT_LINES) {
      formatted.splice(MAX_OUTPUT_LINES);
      formatted.push(`... (${symbols.length - MAX_OUTPUT_LINES} more symbols)`);
    }

    const header = `${filePath} (${lines.length} lines, ${symbols.length} symbols)`;
    return { success: true, output: `${header}\n\n${formatted.join("\n")}` };
  },
};

function extractTypeScriptSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  const patterns: Array<{ regex: RegExp; kind: string }> = [
    { regex: /^export\s+(default\s+)?class\s+(\w+)/, kind: "class" },
    { regex: /^export\s+(default\s+)?abstract\s+class\s+(\w+)/, kind: "abstract class" },
    { regex: /^class\s+(\w+)/, kind: "class" },
    { regex: /^export\s+(default\s+)?interface\s+(\w+)/, kind: "interface" },
    { regex: /^interface\s+(\w+)/, kind: "interface" },
    { regex: /^export\s+(default\s+)?type\s+(\w+)/, kind: "type" },
    { regex: /^type\s+(\w+)\s*=/, kind: "type" },
    { regex: /^export\s+(default\s+)?(async\s+)?function\s+(\w+)/, kind: "function" },
    { regex: /^(async\s+)?function\s+(\w+)/, kind: "function" },
    { regex: /^export\s+const\s+(\w+)\s*=\s*(async\s+)?\(/, kind: "function" },
    { regex: /^export\s+const\s+(\w+)\s*=\s*(async\s+)?function/, kind: "function" },
    { regex: /^export\s+const\s+(\w+)\s*[:=]/, kind: "const" },
    { regex: /^export\s+enum\s+(\w+)/, kind: "enum" },
    { regex: /^enum\s+(\w+)/, kind: "enum" },
    { regex: /^\s+(async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/, kind: "method" },
    { regex: /^\s+(get|set)\s+(\w+)\s*\(/, kind: "accessor" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i] ?? "";
    const trimmed = currentLine.trimStart();
    const indent = currentLine.length - trimmed.length;
    const indentLevel = Math.floor(indent / 2);

    for (const { regex, kind } of patterns) {
      const match = trimmed.match(regex);
      if (match) {
        const name = match[match.length - 1] ?? "";
        if (
          name &&
          !["if", "for", "while", "switch", "catch", "return", "new", "else", "try"].includes(name)
        ) {
          symbols.push({ kind, name, line: i + 1, indent: Math.min(indentLevel, 3) });
        }
        break;
      }
    }
  }

  return symbols;
}

function extractPythonSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i] ?? "";
    const trimmed = currentLine.trimStart();
    const indent = currentLine.length - trimmed.length;
    const indentLevel = Math.floor(indent / 4);

    let match = trimmed.match(/^class\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "class", name: match[1] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^(async\s+)?def\s+(\w+)/);
    if (match) {
      const kind = indentLevel > 0 ? "method" : "function";
      symbols.push({ kind, name: match[2] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    if (indentLevel === 0) {
      match = trimmed.match(/^(\w+)\s*=\s*/);
      if (match) {
        const constName = match[1] ?? "";
        if (constName === constName.toUpperCase()) {
          symbols.push({ kind: "const", name: constName, line: i + 1, indent: 0 });
        }
      }
    }
  }

  return symbols;
}

function extractGoSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i] ?? "";
    const trimmed = currentLine.trimStart();

    let match = trimmed.match(/^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)/);
    if (match) {
      symbols.push({
        kind: "method",
        name: `${match[2] ?? ""}.${match[3] ?? ""}`,
        line: i + 1,
        indent: 1,
      });
      continue;
    }

    match = trimmed.match(/^func\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "function", name: match[1] ?? "", line: i + 1, indent: 0 });
      continue;
    }

    match = trimmed.match(/^type\s+(\w+)\s+struct/);
    if (match) {
      symbols.push({ kind: "struct", name: match[1] ?? "", line: i + 1, indent: 0 });
      continue;
    }

    match = trimmed.match(/^type\s+(\w+)\s+interface/);
    if (match) {
      symbols.push({ kind: "interface", name: match[1] ?? "", line: i + 1, indent: 0 });
      continue;
    }

    match = trimmed.match(/^type\s+(\w+)\s+/);
    if (match) {
      symbols.push({ kind: "type", name: match[1] ?? "", line: i + 1, indent: 0 });
      continue;
    }

    match = trimmed.match(/^var\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "var", name: match[1] ?? "", line: i + 1, indent: 0 });
    }
  }

  return symbols;
}

function extractRustSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i] ?? "";
    const trimmed = currentLine.trimStart();
    const indent = currentLine.length - trimmed.length;
    const indentLevel = Math.floor(indent / 4);

    let match = trimmed.match(/^pub\s+struct\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "struct", name: match[1] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^struct\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "struct", name: match[1] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^pub\s+enum\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "enum", name: match[1] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^pub\s+(async\s+)?fn\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "function", name: match[2] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^(async\s+)?fn\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "function", name: match[2] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^pub\s+trait\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "trait", name: match[1] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^impl\s+(?:(\w+)\s+for\s+)?(\w+)/);
    if (match) {
      const traitName = match[1];
      const typeName = match[2] ?? "";
      const name = traitName ? `${traitName} for ${typeName}` : typeName;
      symbols.push({ kind: "impl", name, line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^mod\s+(\w+)/);
    if (match) {
      symbols.push({ kind: "mod", name: match[1] ?? "", line: i + 1, indent: indentLevel });
    }
  }

  return symbols;
}

function extractRubySymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i] ?? "";
    const trimmed = currentLine.trimStart();
    const indent = currentLine.length - trimmed.length;
    const indentLevel = Math.floor(indent / 2);

    let match = trimmed.match(/^class\s+(\S+)/);
    if (match) {
      symbols.push({ kind: "class", name: match[1] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^module\s+(\S+)/);
    if (match) {
      symbols.push({ kind: "module", name: match[1] ?? "", line: i + 1, indent: indentLevel });
      continue;
    }

    match = trimmed.match(/^def\s+(self\.)?(\w+[?!=]?)/);
    if (match) {
      const isSelfMethod = match[1];
      const methodName = match[2] ?? "";
      const kind = isSelfMethod ? "class_method" : "method";
      symbols.push({
        kind,
        name: isSelfMethod ? `self.${methodName}` : methodName,
        line: i + 1,
        indent: indentLevel,
      });
      continue;
    }

    match = trimmed.match(/^(attr_reader|attr_writer|attr_accessor)\s+(.*)/);
    if (match) {
      symbols.push({
        kind: "attr",
        name: (match[2] ?? "").trim(),
        line: i + 1,
        indent: indentLevel,
      });
    }
  }

  return symbols;
}
