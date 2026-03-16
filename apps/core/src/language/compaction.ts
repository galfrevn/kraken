import { ConversationHistory } from "@/language/conversation.ts";
import { LanguageModelClient } from "@/language/client.ts";
import type { ConversationMessage } from "@/language/schema.ts";

const CHARACTERS_PER_TOKEN_ESTIMATE = 4;
const GENTLE_COMPACTION_THRESHOLD = 0.6;
const MODERATE_COMPACTION_THRESHOLD = 0.75;
const AGGRESSIVE_COMPACTION_THRESHOLD = 0.9;

const MODERATE_COMPACTION_KEEP_RECENT_TURNS = 8;
const AGGRESSIVE_COMPACTION_KEEP_RECENT_TURNS = 4;

const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a conversation summarizer. Given a sequence of messages between a user and an assistant, " +
  "produce a concise summary capturing the key decisions, actions taken, and current state. " +
  "Preserve file names, variable names, and technical details. Reply ONLY with the summary text.";

export interface CompactionResult {
  tier: "none" | "gentle" | "moderate" | "aggressive";
  tokensBeforeCompaction: number;
  tokensAfterCompaction: number;
  messagesRemoved: number;
}

function estimateMessagesTokenCount(messages: ConversationMessage[]): number {
  let totalCharacters = 0;
  for (const message of messages) {
    totalCharacters += message.content.length;
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        totalCharacters += toolCall.function.name.length + toolCall.function.arguments.length;
      }
    }
  }
  return Math.ceil(totalCharacters / CHARACTERS_PER_TOKEN_ESTIMATE);
}

function collapseToolResultsToOneLine(messages: ConversationMessage[]): number {
  let collapsedCount = 0;
  for (const message of messages) {
    if (message.role === "tool" && message.content.length > 200) {
      const firstLine = message.content.split("\n")[0] ?? "";
      const originalLength = message.content.length;
      message.content = `${firstLine} [collapsed ${originalLength} chars]`;
      collapsedCount++;
    }
  }
  return collapsedCount;
}

export async function performTieredCompaction(
  conversation: ConversationHistory,
  languageModelClient: LanguageModelClient,
  maximumContextTokens: number,
): Promise<CompactionResult> {
  const allMessages = conversation.getMessages();
  const currentTokenEstimate = estimateMessagesTokenCount(allMessages);
  const utilizationRatio = currentTokenEstimate / maximumContextTokens;

  if (utilizationRatio < GENTLE_COMPACTION_THRESHOLD) {
    return {
      tier: "none",
      tokensBeforeCompaction: currentTokenEstimate,
      tokensAfterCompaction: currentTokenEstimate,
      messagesRemoved: 0,
    };
  }

  if (utilizationRatio < MODERATE_COMPACTION_THRESHOLD) {
    return performGentleCompaction(conversation, currentTokenEstimate);
  }

  if (utilizationRatio < AGGRESSIVE_COMPACTION_THRESHOLD) {
    return performModerateCompaction(conversation, languageModelClient, currentTokenEstimate);
  }

  return performAggressiveCompaction(conversation, languageModelClient, currentTokenEstimate);
}

function performGentleCompaction(
  conversation: ConversationHistory,
  tokensBeforeCompaction: number,
): CompactionResult {
  const truncatedToolResults = conversation.truncateStaleToolResults();

  const tokensAfterCompaction = estimateMessagesTokenCount(conversation.getMessages());

  return {
    tier: "gentle",
    tokensBeforeCompaction,
    tokensAfterCompaction,
    messagesRemoved: truncatedToolResults,
  };
}

async function performModerateCompaction(
  conversation: ConversationHistory,
  languageModelClient: LanguageModelClient,
  tokensBeforeCompaction: number,
): Promise<CompactionResult> {
  conversation.truncateStaleToolResults();

  const allMessages = conversation.getMessages();
  const keepRecentCount = MODERATE_COMPACTION_KEEP_RECENT_TURNS * 2;

  if (allMessages.length <= keepRecentCount) {
    collapseToolResultsToOneLine(allMessages);
    const tokensAfterCompaction = estimateMessagesTokenCount(conversation.getMessages());
    return {
      tier: "moderate",
      tokensBeforeCompaction,
      tokensAfterCompaction,
      messagesRemoved: 0,
    };
  }

  const oldMessages = allMessages.slice(0, allMessages.length - keepRecentCount);
  const recentMessages = allMessages.slice(allMessages.length - keepRecentCount);

  const summarizationTranscript = buildSummarizationTranscript(oldMessages);

  try {
    await languageModelClient.singlePrompt(
      summarizationTranscript,
      SUMMARIZATION_SYSTEM_PROMPT,
      { temperature: 0.3, maxTokens: 512, model: "openrouter/free" },
    );

    conversation.trimToLastMessages(recentMessages.length);
    conversation.compactIfNeeded();

    const tokensAfterCompaction = estimateMessagesTokenCount(conversation.getMessages());

    return {
      tier: "moderate",
      tokensBeforeCompaction,
      tokensAfterCompaction,
      messagesRemoved: oldMessages.length,
    };
  } catch {
    const fallbackCompactionResult = conversation.compactIfNeeded();
    const tokensAfterCompaction = estimateMessagesTokenCount(conversation.getMessages());
    return {
      tier: "moderate",
      tokensBeforeCompaction,
      tokensAfterCompaction,
      messagesRemoved: fallbackCompactionResult.removedCount,
    };
  }
}

async function performAggressiveCompaction(
  conversation: ConversationHistory,
  languageModelClient: LanguageModelClient,
  tokensBeforeCompaction: number,
): Promise<CompactionResult> {
  conversation.truncateStaleToolResults();

  const allMessages = conversation.getMessages();
  const keepRecentCount = AGGRESSIVE_COMPACTION_KEEP_RECENT_TURNS * 2;

  if (allMessages.length <= keepRecentCount) {
    collapseToolResultsToOneLine(allMessages);
    const tokensAfterCompaction = estimateMessagesTokenCount(conversation.getMessages());
    return {
      tier: "aggressive",
      tokensBeforeCompaction,
      tokensAfterCompaction,
      messagesRemoved: 0,
    };
  }

  const oldMessages = allMessages.slice(0, allMessages.length - keepRecentCount);

  const summarizationTranscript = buildSummarizationTranscript(oldMessages);

  try {
    await languageModelClient.singlePrompt(
      summarizationTranscript,
      SUMMARIZATION_SYSTEM_PROMPT,
      { temperature: 0.2, maxTokens: 768, model: "openrouter/free" },
    );

    conversation.trimToLastMessages(keepRecentCount);
    conversation.compactIfNeeded();

    const tokensAfterCompaction = estimateMessagesTokenCount(conversation.getMessages());

    return {
      tier: "aggressive",
      tokensBeforeCompaction,
      tokensAfterCompaction,
      messagesRemoved: oldMessages.length,
    };
  } catch {
    conversation.trimToLastMessages(keepRecentCount);
    const tokensAfterCompaction = estimateMessagesTokenCount(conversation.getMessages());
    return {
      tier: "aggressive",
      tokensBeforeCompaction,
      tokensAfterCompaction,
      messagesRemoved: oldMessages.length,
    };
  }
}

function buildSummarizationTranscript(messages: ConversationMessage[]): string {
  const transcriptLines: string[] = [];
  let totalCharacterCount = 0;
  const maximumTranscriptCharacters = 4000;

  for (const message of messages) {
    if (totalCharacterCount >= maximumTranscriptCharacters) break;

    if (message.role === "user") {
      const truncatedContent = message.content.length > 300 ? message.content.slice(0, 300) + "..." : message.content;
      transcriptLines.push(`User: ${truncatedContent}`);
      totalCharacterCount += truncatedContent.length;
    } else if (message.role === "assistant") {
      const truncatedContent = message.content.length > 300 ? message.content.slice(0, 300) + "..." : message.content;
      transcriptLines.push(`Assistant: ${truncatedContent}`);
      totalCharacterCount += truncatedContent.length;
    } else if (message.role === "tool") {
      const toolName = message.name ?? "tool";
      transcriptLines.push(`Tool (${toolName}): [result]`);
      totalCharacterCount += 20;
    }
  }

  return transcriptLines.join("\n\n");
}
