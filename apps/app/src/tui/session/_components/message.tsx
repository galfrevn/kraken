import { useMemo } from "react";
import { SyntaxStyle } from "@opentui/core";
import { useTheme } from "@/tui/_context/theme.tsx";
import { EMPTY_BORDER_CHARACTERS } from "@/tui/_theme/borders.ts";

function useMarkdownSyntaxStyle() {
  const { theme } = useTheme();
  return useMemo(() => {
    return SyntaxStyle.fromTheme([
      { scope: ["markup.heading"], style: { foreground: theme.markdownHeading, bold: true } },
      {
        scope: ["markup.bold", "markup.strong"],
        style: { foreground: theme.markdownStrong, bold: true },
      },
      { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
      { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.markdownCode } },
      { scope: ["markup.link"], style: { foreground: theme.markdownLink, underline: true } },
      { scope: ["markup.link.text"], style: { foreground: theme.markdownLinkText } },
      { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
      { scope: ["markup.list.enumeration"], style: { foreground: theme.markdownListEnumeration } },
      { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
      { scope: ["markup.horizontal_rule"], style: { foreground: theme.markdownHorizontalRule } },
      { scope: ["comment"], style: { foreground: theme.syntaxComment } },
      { scope: ["keyword"], style: { foreground: theme.syntaxKeyword } },
      { scope: ["function"], style: { foreground: theme.syntaxFunction } },
      { scope: ["variable"], style: { foreground: theme.syntaxVariable } },
      { scope: ["string"], style: { foreground: theme.syntaxString } },
      { scope: ["number", "constant.numeric"], style: { foreground: theme.syntaxNumber } },
      { scope: ["type"], style: { foreground: theme.syntaxType } },
      { scope: ["operator"], style: { foreground: theme.syntaxOperator } },
      { scope: ["punctuation"], style: { foreground: theme.syntaxPunctuation } },
    ]);
  }, [theme]);
}

function useSubtleSyntaxStyle() {
  const { theme } = useTheme();
  return useMemo(() => {
    const muted = theme.textMuted;
    return SyntaxStyle.fromTheme([
      { scope: ["markup.heading"], style: { foreground: muted } },
      { scope: ["markup.bold", "markup.strong"], style: { foreground: muted } },
      { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
      { scope: ["markup.raw", "markup.raw.block"], style: { foreground: muted } },
      { scope: ["markup.link"], style: { foreground: muted } },
      { scope: ["markup.link.text"], style: { foreground: muted } },
      { scope: ["markup.list"], style: { foreground: muted } },
      { scope: ["markup.list.enumeration"], style: { foreground: muted } },
      { scope: ["markup.quote"], style: { foreground: muted, italic: true } },
    ]);
  }, [theme]);
}

interface UserMessageProperties {
  messageText: string;
}

export const UserMessage = ({ messageText }: UserMessageProperties) => {
  const { theme } = useTheme();

  return (
    <box
      border={["left"] as const}
      customBorderChars={{
        ...EMPTY_BORDER_CHARACTERS,
        vertical: "┃",
      }}
      borderColor={theme.secondary}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      backgroundColor={theme.backgroundPanel}
      marginTop={1}
      flexShrink={0}
    >
      <text fg={theme.text} content={messageText} />
    </box>
  );
};

interface AssistantMessageProperties {
  messageText: string;
  isStreaming: boolean;
}

export const AssistantMessage = ({ messageText, isStreaming }: AssistantMessageProperties) => {
  const markdownSyntaxStyle = useMarkdownSyntaxStyle();

  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <markdown
        content={messageText.trim()}
        syntaxStyle={markdownSyntaxStyle}
        streaming={isStreaming}
        conceal
      />
    </box>
  );
};

interface AssistantMetadataProperties {
  agentName: string;
  agentColor?: string;
  modelId: string;
  durationSeconds: number;
}

export const AssistantMetadata = ({
  agentName,
  agentColor,
  modelId,
  durationSeconds,
}: AssistantMetadataProperties) => {
  const { theme } = useTheme();

  const resolvedColor = agentColor ?? theme.secondary;
  const formattedDuration =
    durationSeconds >= 60
      ? `${Math.floor(durationSeconds / 60)}m ${Math.round(durationSeconds % 60)}s`
      : `${durationSeconds.toFixed(1)}s`;

  return (
    <box paddingLeft={3} marginTop={1}>
      <text>
        <span fg={resolvedColor}>▣ </span>
        <span fg={theme.text}>{agentName}</span>
        <span fg={theme.textMuted}> · {modelId}</span>
        <span fg={theme.textMuted}> · {formattedDuration}</span>
      </text>
    </box>
  );
};

interface ReasoningMessageProperties {
  reasoningText: string;
  isStreaming?: boolean;
}

export const ReasoningMessage = ({ reasoningText, isStreaming }: ReasoningMessageProperties) => {
  const { theme } = useTheme();
  const subtleSyntax = useSubtleSyntaxStyle();

  const cleanedText = reasoningText.replace(/\[REDACTED\]/g, "").trim();

  if (!cleanedText && !isStreaming) return null;

  const markdownContent =
    isStreaming && !cleanedText ? "_Thinking…_" : `_Thinking:_ ${cleanedText}`;

  return (
    <box
      paddingLeft={2}
      marginTop={1}
      flexShrink={0}
      flexDirection="column"
      border={["left"] as const}
      customBorderChars={{
        ...EMPTY_BORDER_CHARACTERS,
        vertical: "│",
      }}
      borderColor={theme.borderSubtle}
    >
      <markdown
        content={markdownContent}
        syntaxStyle={subtleSyntax}
        streaming={isStreaming}
        conceal
        fg={theme.textMuted}
      />
    </box>
  );
};
