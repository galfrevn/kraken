import { MESSAGE_ROLE, type ConversationMessage } from "@/language/schema.ts";

export class ConversationHistory {
  private messages: ConversationMessage[] = [];
  private systemPrompt: string | undefined;

  constructor(systemPrompt?: string) {
    this.systemPrompt = systemPrompt;
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

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  getMessagesWithSystemPrompt(): ConversationMessage[] {
    if (!this.systemPrompt) return this.getMessages();
    return [{ role: MESSAGE_ROLE.system, content: this.systemPrompt }, ...this.messages];
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

  clear(): void {
    this.messages = [];
  }

  reset(): void {
    this.messages = [];
    this.systemPrompt = undefined;
  }
}
