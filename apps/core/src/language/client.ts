import { createGatewayClient, type GatewayClient } from "@/clients/gateway.ts";
import { ConversationHistory } from "@/language/conversation.ts";

import type { LanguageModelConfiguration } from "@/configuration/schema.ts";
import type {
  ConversationMessage,
  CompletionOptions,
  CompletionResult,
  TokenUsageSummary,
  StreamDeltaCallback,
} from "@/language/schema.ts";

export class LanguageModelClient {
  private gatewayClient: GatewayClient;
  private model: string;
  private defaultTemperature: number;
  private defaultMaxTokens: number;
  private tokenUsage: TokenUsageSummary;

  constructor(gatewayUrl: string, languageModelConfiguration: LanguageModelConfiguration) {
    this.gatewayClient = createGatewayClient(gatewayUrl);
    this.model = languageModelConfiguration.model;
    this.defaultTemperature = languageModelConfiguration.temperature;
    this.defaultMaxTokens = languageModelConfiguration.maxTokens;
    this.tokenUsage = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      requestCount: 0,
    };
  }

  async complete(
    messages: ConversationMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const gatewayMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const systemMessage = messages.find((message) => message.role === "system");
    const systemPrompt = options?.systemPrompt ?? systemMessage?.content;

    const response = await this.gatewayClient.complete({
      model: options?.model ?? this.model,
      messages: gatewayMessages,
      temperature: options?.temperature ?? this.defaultTemperature,
      maxTokens: options?.maxTokens ?? this.defaultMaxTokens,
      systemPrompt,
    });

    this.tokenUsage.totalPromptTokens += response.promptTokens;
    this.tokenUsage.totalCompletionTokens += response.completionTokens;
    this.tokenUsage.requestCount += 1;

    return {
      id: response.id,
      model: response.model,
      content: response.message?.content ?? "",
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
    };
  }

  async completeConversation(
    conversation: ConversationHistory,
    userMessage: string,
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    conversation.addUserMessage(userMessage);

    const messages = conversation.getMessagesWithSystemPrompt();
    const result = await this.complete(messages, options);

    conversation.addAssistantMessage(result.content);
    return result;
  }

  async streamConversation(
    conversation: ConversationHistory,
    userMessage: string,
    onDelta: StreamDeltaCallback,
    options?: CompletionOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    conversation.addUserMessage(userMessage);

    try {
      return await this.executeStreamConversation(conversation, onDelta, options, signal);
    } catch (streamError) {
      if (signal?.aborted) throw streamError;
      const messages = conversation.getMessagesWithSystemPrompt();
      const result = await this.complete(messages, options);
      conversation.addAssistantMessage(result.content);
      onDelta({ content: result.content, done: true });
      return result.content;
    }
  }

  private async executeStreamConversation(
    conversation: ConversationHistory,
    onDelta: StreamDeltaCallback,
    options?: CompletionOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const allMessages = conversation.getMessagesWithSystemPrompt();

    const gatewayMessages = allMessages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const systemMessage = allMessages.find((message) => message.role === "system");
    const systemPrompt = options?.systemPrompt ?? systemMessage?.content;

    const stream = this.gatewayClient.streamComplete({
      model: this.model,
      messages: gatewayMessages,
      temperature: options?.temperature ?? this.defaultTemperature,
      maxTokens: options?.maxTokens ?? this.defaultMaxTokens,
      systemPrompt,
    });

    let fullContent = "";

    const iterator = stream[Symbol.asyncIterator]();
    const INACTIVITY_TIMEOUT_MILLISECONDS = 30_000;

    while (true) {
      if (signal?.aborted) break;

      const timeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("stream inactivity timeout")),
          INACTIVITY_TIMEOUT_MILLISECONDS,
        );
        if (signal) {
          signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        }
      });

      let result: IteratorResult<typeof stream extends AsyncIterable<infer T> ? T : never>;
      try {
        result = (await Promise.race([iterator.next(), timeoutPromise])) as typeof result;
      } catch (raceError) {
        if (raceError instanceof Error && raceError.message === "stream inactivity timeout") {
          onDelta({ content: "", done: true });
          break;
        }
        throw raceError;
      }

      if (result.done) break;

      const chunk = result.value;
      fullContent += chunk.delta;
      onDelta({ content: chunk.delta, done: chunk.done });

      if (chunk.promptTokens > 0) {
        this.tokenUsage.totalPromptTokens += chunk.promptTokens;
      }
      if (chunk.completionTokens > 0) {
        this.tokenUsage.totalCompletionTokens += chunk.completionTokens;
      }

      if (chunk.done) break;
    }

    conversation.addAssistantMessage(fullContent);

    this.tokenUsage.requestCount += 1;

    return fullContent;
  }

  async singlePrompt(
    prompt: string,
    systemPrompt?: string,
    options?: CompletionOptions,
  ): Promise<string> {
    const messages: ConversationMessage[] = [{ role: "user", content: prompt }];

    const result = await this.complete(messages, {
      ...options,
      systemPrompt,
    });

    return result.content;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getTokenUsage(): TokenUsageSummary {
    return { ...this.tokenUsage };
  }

  resetTokenUsage(): void {
    this.tokenUsage = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      requestCount: 0,
    };
  }
}
