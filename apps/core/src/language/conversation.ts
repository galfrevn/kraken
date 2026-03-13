import { MESSAGE_ROLE, type ConversationMessage, type ToolCallEntry } from "@/language/schema.ts";

export interface ConversationHistoryOptions {
  maxMessages?: number;
  /** Max characters for tool results kept in history. Default: 800 */
  staleToolResultMaxChars?: number;
}

/** How many "turns" (assistant responses) a tool result stays at full size before truncation. */
const TOOL_RESULT_FRESH_TURNS = 1;
const DEFAULT_STALE_TOOL_MAX_CHARS = 800;

export class ConversationHistory {
  private messages: ConversationMessage[] = [];
  private systemPrompt: string | undefined;
  private options: ConversationHistoryOptions;
  private summaryPrefix: string | undefined;

  constructor(systemPrompt?: string, options?: ConversationHistoryOptions) {
    this.systemPrompt = systemPrompt;
    this.options = options ?? {};
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt;
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: MESSAGE_ROLE.user, content });
  }

  addAssistantMessage(content: string): void {
    this.messages.push({ role: MESSAGE_ROLE.assistant, content });
  }

  addAssistantToolCallMessage(content: string, toolCalls: ToolCallEntry[]): void {
    this.messages.push({ role: MESSAGE_ROLE.assistant, content, toolCalls });
  }

  addToolResultMessage(toolCallId: string, toolName: string, content: string): void {
    this.messages.push({
      role: MESSAGE_ROLE.tool,
      content,
      toolCallId,
      name: toolName,
    });
  }

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  getMessagesWithSystemPrompt(): ConversationMessage[] {
    const result: ConversationMessage[] = [];
    if (this.systemPrompt) {
      result.push({ role: MESSAGE_ROLE.system, content: this.systemPrompt });
    }
    if (this.summaryPrefix) {
      result.push({
        role: MESSAGE_ROLE.user,
        content: `[Earlier conversation summary]\n${this.summaryPrefix}`,
      });
      result.push({
        role: MESSAGE_ROLE.assistant,
        content: "Understood, I have context from the earlier conversation.",
      });
    }
    result.push(...this.messages);
    return result;
  }

  getLastMessage(): ConversationMessage | undefined {
    return this.messages.at(-1);
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  trimToLastMessages(count: number): void {
    if (this.messages.length > count) {
      this.messages = this.messages.slice(-count);
    }
  }

  /**
   * Truncate tool results that the LLM has already seen and responded to.
   * Keeps the most recent tool results at full size (within TOOL_RESULT_FRESH_TURNS
   * assistant responses), and truncates older ones to save tokens.
   */
  truncateStaleToolResults(): number {
    const maxChars = this.options.staleToolResultMaxChars ?? DEFAULT_STALE_TOOL_MAX_CHARS;
    let assistantTurnsSeen = 0;
    let truncatedCount = 0;

    // Walk backwards: count assistant turns to determine freshness
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;

      if (msg.role === MESSAGE_ROLE.assistant) {
        assistantTurnsSeen++;
      }

      if (msg.role === MESSAGE_ROLE.tool && assistantTurnsSeen > TOOL_RESULT_FRESH_TURNS) {
        if (msg.content.length > maxChars) {
          const head = msg.content.slice(0, maxChars / 2);
          const tail = msg.content.slice(-maxChars / 4);
          msg.content = `${head}\n\n... [truncated ${msg.content.length - maxChars} chars] ...\n\n${tail}`;
          truncatedCount++;
        }
      }
    }

    return truncatedCount;
  }

  compactIfNeeded(): { didCompact: boolean; removedCount: number } {
    // Always truncate stale tool results first
    this.truncateStaleToolResults();

    const limit = this.options.maxMessages ?? 20;
    if (this.messages.length <= limit) return { didCompact: false, removedCount: 0 };

    const cutIndex = Math.floor(this.messages.length / 2);
    const oldMessages = this.messages.slice(0, cutIndex);
    this.messages = this.messages.slice(cutIndex);

    const summaryLines: string[] = [];
    for (const msg of oldMessages) {
      if (msg.role === "user") {
        summaryLines.push(`User: ${msg.content.slice(0, 200)}`);
      } else if (msg.role === "assistant") {
        summaryLines.push(`Assistant: ${msg.content.slice(0, 200)}`);
      }
    }

    this.summaryPrefix = summaryLines.join("\n");
    return { didCompact: true, removedCount: oldMessages.length };
  }

  clear(): void {
    this.messages = [];
  }

  reset(): void {
    this.messages = [];
    this.systemPrompt = undefined;
  }
}
