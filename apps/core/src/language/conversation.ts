import { MESSAGE_ROLE, type ConversationMessage, type ToolCallEntry } from "@/language/schema.ts";

export interface ConversationHistoryOptions {
  maxMessages?: number;
}

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

  compactIfNeeded(): { didCompact: boolean; removedCount: number } {
    const limit = this.options.maxMessages ?? 40;
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
