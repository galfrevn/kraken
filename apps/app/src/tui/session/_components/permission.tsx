import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/tui/_context/theme.tsx";
import { EMPTY_BORDER_CHARACTERS } from "@/tui/_theme/borders.ts";
import type { PermissionRequest } from "@/tool/permission.ts";

const FILETYPE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
};

function resolveFiletype(filepath: string): string {
  const ext = filepath.split(".").pop() ?? "";
  return FILETYPE_MAP[ext] ?? ext;
}

interface PermissionPromptProperties {
  request: PermissionRequest;
  agentColor?: string;
  onApprove: () => void;
  onApproveAlways: () => void;
  onReject: () => void;
}

export const PermissionPrompt = ({
  request,
  agentColor,
  onApprove,
  onApproveAlways,
  onReject,
}: PermissionPromptProperties) => {
  const { theme } = useTheme();
  const { width: termWidth } = useTerminalDimensions();
  const color = agentColor ?? theme.secondary;

  const title =
    request.toolId === "bash"
      ? "Run command"
      : request.toolId === "write"
        ? `Write ${request.filepath ?? "file"}`
        : `Edit ${request.filepath ?? "file"}`;

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "y" || keyEvent.name === "return") {
      onApprove();
    } else if (keyEvent.name === "a") {
      onApproveAlways();
    } else if (keyEvent.name === "n" || keyEvent.name === "escape") {
      onReject();
    }
  });

  const viewMode = termWidth > 120 ? "split" : "unified";

  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <box
        border={["left"] as const}
        borderColor={theme.warning}
        customBorderChars={{
          ...EMPTY_BORDER_CHARACTERS,
          vertical: "┃",
          bottomLeft: "╹",
        }}
        backgroundColor={theme.backgroundElement}
      >
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingY={1}>
          <text fg={theme.text} content={title} attributes={TextAttributes.BOLD} />

          <box height={1} />

          {request.diff ? (
            <box paddingLeft={1}>
              <diff
                diff={request.diff}
                view={viewMode}
                filetype={resolveFiletype(request.filepath ?? "")}
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
          ) : request.command ? (
            <box paddingLeft={1}>
              <text fg={theme.warning} content="$ " />
              <text fg={theme.text} content={request.command} />
            </box>
          ) : request.filepath ? (
            <text fg={theme.textMuted} content={`  ${request.filepath}`} />
          ) : null}
        </box>
      </box>

      <box flexDirection="row" gap={2} paddingLeft={3} marginTop={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.success} content="y" />
          <text fg={theme.textMuted} content="allow" />
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={color} content="a" />
          <text fg={theme.textMuted} content="always" />
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.error} content="n" />
          <text fg={theme.textMuted} content="reject" />
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} content="esc" />
          <text fg={theme.textMuted} content="dismiss" />
        </box>
      </box>
    </box>
  );
};
