import { COLORS } from "@/theme.ts";
import type { ChatMessage } from "@/engine.ts";

interface ToolCallDisplayProperties {
  toolCallMessage: ChatMessage;
  toolResultMessage?: ChatMessage;
}

export function ToolCallDisplay({ toolCallMessage, toolResultMessage }: ToolCallDisplayProperties) {
  const toolName = toolCallMessage.toolName ?? "unknown";
  const isCompleted = toolResultMessage !== undefined;
  const isSuccessful = toolResultMessage?.toolSuccess ?? false;

  const statusIndicator = !isCompleted ? "▶" : isSuccessful ? "✓" : "✗";
  const statusColor = !isCompleted ? COLORS.blue : isSuccessful ? COLORS.green : COLORS.red;

  const resultPreview = toolResultMessage?.content
    ? toolResultMessage.content.length > 120
      ? toolResultMessage.content.slice(0, 120) + "..."
      : toolResultMessage.content
    : "";

  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row">
        <text fg={statusColor}>{statusIndicator + " "}</text>
        <text fg={COLORS.yellow}>{toolName}</text>
        {isCompleted && resultPreview && (
          <text fg={COLORS.textMuted}>{" — " + resultPreview.split("\n")[0]}</text>
        )}
      </box>
    </box>
  );
}
