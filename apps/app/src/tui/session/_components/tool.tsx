import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/tui/_context/theme.tsx";
import { EMPTY_BORDER_CHARACTERS } from "@/tui/_theme/borders.ts";

const TOOL_ICONS: Record<string, string> = {
  bash: "$",
  read: "→",
  write: "←",
  edit: "←",
  glob: "✱",
  grep: "✱",
  schedule_task: "⏱",
  skill: "→",
  webfetch: "%",
  memory_save: "◆",
  memory_search: "◇",
  memory_context: "◇",
};

const TOOL_RESULT_COLLAPSED_LINES = 3;
const TOOL_RESULT_EXPANDED_MAX_LINES = 30;
const LIVE_OUTPUT_MAX_LINES = 15;

function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? "⚙";
}

function formatToolLabel(toolName: string, toolInput?: string): string {
  if (!toolInput) return toolName;

  try {
    const args = JSON.parse(toolInput) as Record<string, unknown>;

    switch (toolName) {
      case "bash":
        return args.command ? `${args.command}` : toolName;
      case "read":
        return args.filePath ? `Read ${args.filePath}` : toolName;
      case "write":
        return args.filePath ? `Write ${args.filePath}` : toolName;
      case "edit":
        return args.filePath ? `Edit ${args.filePath}` : toolName;
      case "glob":
        return args.pattern ? `${args.pattern}` : toolName;
      case "grep":
        return args.pattern ? `/${args.pattern}/` : toolName;
      case "schedule_task":
        return args.prompt ? `Schedule: ${String(args.prompt).slice(0, 60)}` : toolName;
      case "skill":
        return args.name ? `Skill "${args.name}"` : toolName;
      case "webfetch":
        return args.url ? `WebFetch ${args.url}` : toolName;
      case "memory_save":
        return args.category ? `Save memory [${args.category}]` : "Save memory";
      case "memory_search":
        return args.query ? `Search memory: ${String(args.query).slice(0, 50)}` : "Search memory";
      case "memory_context":
        return "Load memory context";
      default:
        return toolName;
    }
  } catch {
    return toolName;
  }
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

const FILETYPE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
};

function resolveFiletype(ext: string): string {
  return FILETYPE_MAP[ext] ?? ext;
}

interface ToolCallDisplayProperties {
  toolName: string;
  toolInput?: string;
  state: "running" | "completed" | "error";
  resultContent?: string;
  liveOutput?: string;
}

function extractDiff(content: string): { text: string; diff: string | null; filetype: string } {
  const match = content.match(/<!--diff:(\w*)-->\n([\s\S]*?)\n<!--\/diff-->/);
  if (!match) return { text: content, diff: null, filetype: "" };
  const text = content.slice(0, match.index).trim();
  return { text, diff: match[2]!, filetype: match[1] ?? "" };
}

export const ToolCallDisplay = ({
  toolName,
  toolInput,
  state,
  resultContent,
  liveOutput,
}: ToolCallDisplayProperties) => {
  const { theme } = useTheme();
  const { width: termWidth } = useTerminalDimensions();
  const [expanded, setExpanded] = useState(false);

  const icon = getToolIcon(toolName);
  const label = formatToolLabel(toolName, toolInput);
  const isBash = toolName === "bash";
  const isEdit = toolName === "edit" || toolName === "write";
  const hasBlockOutput = isBash && state === "completed" && resultContent;
  const hasLiveOutput = isBash && state === "running" && liveOutput;

  const iconColor =
    state === "running" ? theme.warning : state === "error" ? theme.error : theme.textMuted;

  if (hasLiveOutput) {
    const visibleOutput = tailLines(liveOutput, LIVE_OUTPUT_MAX_LINES);

    return (
      <box
        flexDirection="column"
        marginTop={1}
        paddingLeft={3}
        flexShrink={0}
        border={["left"] as const}
        customBorderChars={{ ...EMPTY_BORDER_CHARACTERS, vertical: "│" }}
        borderColor={theme.warning}
      >
        <box flexDirection="row" gap={1}>
          <text fg={iconColor} content={icon} />
          <text fg={theme.textMuted} content={label} attributes={TextAttributes.BOLD} />
          <text fg={theme.warning} content="⟳" />
        </box>
        <box paddingTop={1} paddingLeft={2}>
          <text fg={theme.textMuted} content={visibleOutput} />
        </box>
      </box>
    );
  }

  if (hasBlockOutput) {
    const outputLines = resultContent.split("\n");
    const maxLines = expanded ? TOOL_RESULT_EXPANDED_MAX_LINES : TOOL_RESULT_COLLAPSED_LINES;
    const isOverflowing = outputLines.length > maxLines;
    const visibleOutput = isOverflowing
      ? outputLines.slice(0, maxLines).join("\n") + "\n…"
      : resultContent;

    return (
      <box
        flexDirection="column"
        marginTop={1}
        paddingLeft={3}
        flexShrink={0}
        border={["left"] as const}
        customBorderChars={{ ...EMPTY_BORDER_CHARACTERS, vertical: "│" }}
        borderColor={theme.borderSubtle}
      >
        <box flexDirection="row" gap={1} onMouseUp={() => isOverflowing && setExpanded(!expanded)}>
          <text fg={iconColor} content={icon} />
          <text fg={theme.textMuted} content={label} attributes={TextAttributes.BOLD} />
        </box>
        <box paddingTop={1} paddingLeft={2}>
          <text fg={theme.textMuted} content={visibleOutput} />
        </box>
      </box>
    );
  }

  if (isEdit && state === "completed" && resultContent) {
    const { text, diff, filetype } = extractDiff(resultContent);
    const viewMode = termWidth > 120 ? "split" : "unified";

    return (
      <box
        flexDirection="column"
        marginTop={1}
        paddingLeft={3}
        flexShrink={0}
        border={["left"] as const}
        customBorderChars={{ ...EMPTY_BORDER_CHARACTERS, vertical: "│" }}
        borderColor={theme.borderSubtle}
      >
        <box flexDirection="row" gap={1}>
          <text fg={iconColor} content={icon} />
          <text fg={theme.textMuted} content={label} attributes={TextAttributes.BOLD} />
        </box>
        {diff ? (
          <box paddingTop={1} paddingLeft={1}>
            <diff
              diff={diff}
              view={viewMode}
              filetype={resolveFiletype(filetype)}
              showLineNumbers
              wrapMode="word"
              addedBg="#1a2e1a"
              removedBg="#2e1a1a"
              contextBg="#1a1a1a"
              addedSignColor="#22c55e"
              removedSignColor="#ef4444"
              lineNumberFg="#555555"
              addedLineNumberBg="#1a2e1a"
              removedLineNumberBg="#2e1a1a"
              width="100%"
            />
          </box>
        ) : (
          <text fg={theme.textMuted} content={`  ${text}`} />
        )}
      </box>
    );
  }

  return (
    <box paddingLeft={3} marginTop={1} flexDirection="row" gap={1} flexShrink={0}>
      <text fg={iconColor} content={icon} />
      <text fg={theme.textMuted} content={label} />
      {state === "completed" && resultContent && !isBash && (
        <text
          fg={theme.textMuted}
          content={`→ ${resultContent.length > 80 ? resultContent.slice(0, 80) + "…" : resultContent}`}
        />
      )}
    </box>
  );
};
