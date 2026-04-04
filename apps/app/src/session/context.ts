import type { CoreMessage } from "ai";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_RESERVE_FOR_OUTPUT = 16_384;
const DEFAULT_RESERVE_FOR_SYSTEM = 2_000;
const DEFAULT_SUMMARIZE_THRESHOLD = 0.75;
const DEFAULT_KEEP_RECENT_MESSAGES = 10;
const TOOL_RESULT_MAX_TOKENS = 4_000;
const SUMMARY_LAST_REASONING_MAX_LENGTH = 500;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function estimateMessageTokens(messages: CoreMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content as unknown as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string") {
          total += estimateTokens(part.text);
        } else if (part.type === "tool-result" && part.result !== undefined) {
          total += estimateTokens(JSON.stringify(part.result));
        } else if (part.type === "tool-call" && part.args !== undefined) {
          total += estimateTokens(JSON.stringify(part.args));
        }
      }
    }
  }
  return total;
}

interface ContextWindowConfig {
  maxContextTokens: number;
  reserveForOutput?: number;
  reserveForSystem?: number;
  summarizeThreshold?: number;
  keepRecentMessages?: number;
}

interface ContextResult {
  messages: CoreMessage[];
  wasTruncated: boolean;
  originalTokens: number;
  finalTokens: number;
}

export function manageContextWindow(
  messages: CoreMessage[],
  config: ContextWindowConfig,
): ContextResult {
  const reserveForOutput = config.reserveForOutput ?? DEFAULT_RESERVE_FOR_OUTPUT;
  const reserveForSystem = config.reserveForSystem ?? DEFAULT_RESERVE_FOR_SYSTEM;
  const summarizeThreshold = config.summarizeThreshold ?? DEFAULT_SUMMARIZE_THRESHOLD;
  const keepRecentMessages = config.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;

  const originalTokens = estimateMessageTokens(messages);
  const availableTokens = config.maxContextTokens - reserveForOutput - reserveForSystem;

  if (originalTokens <= availableTokens * summarizeThreshold) {
    return { messages, wasTruncated: false, originalTokens, finalTokens: originalTokens };
  }

  const truncatedMessages = truncateToolResults(messages);
  const tokensAfterTruncation = estimateMessageTokens(truncatedMessages);

  if (tokensAfterTruncation <= availableTokens * summarizeThreshold) {
    return {
      messages: truncatedMessages,
      wasTruncated: true,
      originalTokens,
      finalTokens: tokensAfterTruncation,
    };
  }

  if (truncatedMessages.length <= keepRecentMessages + 1) {
    return {
      messages: truncatedMessages,
      wasTruncated: true,
      originalTokens,
      finalTokens: tokensAfterTruncation,
    };
  }

  const firstMessage = truncatedMessages[0];
  const recentBoundary = findRoundBoundary(truncatedMessages, keepRecentMessages);
  const recentMessages = truncatedMessages.slice(recentBoundary);
  const middleMessages = truncatedMessages.slice(1, recentBoundary);

  const summaryText = buildExtractiveSummary(middleMessages);
  const summaryMessage: CoreMessage = {
    role: "user",
    content: `[Previous conversation summary — ${middleMessages.length} messages condensed]\n\n${summaryText}`,
  };

  const managedMessages: CoreMessage[] = [];
  if (firstMessage) managedMessages.push(firstMessage);
  managedMessages.push(summaryMessage);
  managedMessages.push(...recentMessages);

  const finalTokens = estimateMessageTokens(managedMessages);
  return { messages: managedMessages, wasTruncated: true, originalTokens, finalTokens };
}

function findRoundBoundary(messages: CoreMessage[], keepCount: number): number {
  const targetIndex = messages.length - keepCount;
  if (targetIndex <= 1) return 1;

  for (let i = targetIndex; i >= 1; i--) {
    const msg = messages[i];
    if (msg && msg.role !== "tool") return i;
  }
  return targetIndex;
}

function truncateToolResults(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;

    const parts = message.content as unknown as Array<Record<string, unknown>>;
    const truncatedContent = parts.map((part) => {
      if (part.type !== "tool-result" || part.result === undefined) return part;
      const resultString =
        typeof part.result === "string" ? part.result : JSON.stringify(part.result);
      const resultTokens = estimateTokens(resultString);

      if (resultTokens <= TOOL_RESULT_MAX_TOKENS) return part;

      const maxChars = TOOL_RESULT_MAX_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
      const halfChars = Math.floor(maxChars / 2);
      const truncatedResult = `${resultString.slice(0, halfChars)}\n\n[... ${resultTokens - TOOL_RESULT_MAX_TOKENS} tokens truncated ...]\n\n${resultString.slice(-halfChars)}`;

      return { ...part, result: truncatedResult };
    });

    return { ...message, content: truncatedContent } as unknown as CoreMessage;
  });
}

function buildExtractiveSummary(messages: CoreMessage[]): string {
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const commandsRun: string[] = [];
  let lastAssistantText = "";

  for (const message of messages) {
    if (message.role === "assistant") {
      if (typeof message.content === "string" && message.content) {
        lastAssistantText = message.content;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content as unknown as Array<Record<string, unknown>>) {
          if (part.type === "text" && typeof part.text === "string") {
            lastAssistantText = part.text;
          }
          if (part.type === "tool-call" && typeof part.toolName === "string") {
            const args = part.args as Record<string, unknown> | undefined;
            const filePath =
              (args?.filePath as string) ?? (args?.path as string) ?? (args?.file as string) ?? "";
            if (part.toolName === "read" && filePath) filesRead.add(filePath);
            if ((part.toolName === "write" || part.toolName === "edit") && filePath)
              filesModified.add(filePath);
            if (part.toolName === "bash" && typeof args?.command === "string")
              commandsRun.push(args.command);
          }
        }
      }
    }
  }

  const sections: string[] = [];

  if (filesRead.size > 0) {
    sections.push(`Files read: ${[...filesRead].join(", ")}`);
  }
  if (filesModified.size > 0) {
    sections.push(`Files modified: ${[...filesModified].join(", ")}`);
  }
  if (commandsRun.length > 0) {
    const recentCommands = commandsRun.slice(-5);
    sections.push(`Recent commands: ${recentCommands.join("; ")}`);
  }
  if (lastAssistantText) {
    const truncated = lastAssistantText.slice(0, SUMMARY_LAST_REASONING_MAX_LENGTH);
    sections.push(`Last assistant reasoning: ${truncated}`);
  }

  if (sections.length === 0) {
    sections.push(`${messages.length} messages were exchanged (details condensed).`);
  }

  return sections.join("\n");
}
