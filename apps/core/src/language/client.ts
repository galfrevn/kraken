import { createGatewayClient, type GatewayClient } from "@/clients/gateway.ts";
import { ConversationHistory } from "@/language/conversation.ts";

import type { LanguageModelConfiguration } from "@/configuration/schema.ts";
import type {
  ConversationMessage,
  CompletionOptions,
  CompletionResult,
  TokenUsageSummary,
  StreamDeltaCallback,
  ToolCallEntry,
} from "@/language/schema.ts";
import type { NativeTool } from "@/tools/schema.ts";

export type ClientLogCallback = (level: "info" | "warn" | "error", message: string) => void;

export class LanguageModelClient {
  private gatewayClient: GatewayClient;
  private model: string;
  private provider: string;
  private defaultTemperature: number;
  private defaultMaxTokens: number;
  private tokenUsage: TokenUsageSummary;
  private nativeTools: NativeTool[] = [];
  private logCallback?: ClientLogCallback;

  constructor(gatewayUrl: string, languageModelConfiguration: LanguageModelConfiguration) {
    this.gatewayClient = createGatewayClient(gatewayUrl);
    this.model = languageModelConfiguration.model;
    this.provider = languageModelConfiguration.provider;
    this.defaultTemperature = languageModelConfiguration.temperature;
    this.defaultMaxTokens = languageModelConfiguration.maxTokens;
    this.tokenUsage = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      requestCount: 0,
    };
  }

  setLogCallback(callback: ClientLogCallback): void {
    this.logCallback = callback;
  }

  private clientLog(level: "info" | "warn" | "error", message: string): void {
    if (this.logCallback) {
      this.logCallback(level, message);
    }
  }

  setNativeTools(tools: NativeTool[]): void {
    this.nativeTools = tools;
  }

  private buildGatewayTools():
    | {
        type: string;
        function: {
          name: string;
          description: string;
          parameters: { type: string; propertiesJson: string; required: string[] };
        };
      }[]
    | undefined {
    if (this.nativeTools.length === 0) return undefined;
    return this.nativeTools.map((tool) => ({
      type: tool.type,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: {
          type: tool.function.parameters.type,
          propertiesJson: JSON.stringify(tool.function.parameters.properties),
          required: tool.function.parameters.required,
        },
      },
    }));
  }

  private buildGatewayMessages(messages: ConversationMessage[]): {
    role: string;
    content: string;
    toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    toolCallId?: string;
    name?: string;
  }[] {
    return messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        const msg: {
          role: string;
          content: string;
          toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[];
          toolCallId?: string;
          name?: string;
        } = {
          role: message.role,
          content: message.content,
        };
        if (message.toolCalls && message.toolCalls.length > 0) {
          msg.toolCalls = message.toolCalls;
        }
        if (message.toolCallId) {
          msg.toolCallId = message.toolCallId;
        }
        if (message.name) {
          msg.name = message.name;
        }
        return msg;
      });
  }

  async complete(
    messages: ConversationMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeComplete(messages, options);
        return result;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isRetryable = errorMsg.includes("empty response") || errorMsg.includes("no choices");

        if (isRetryable && attempt < maxRetries) {
          const delayMs = (attempt + 1) * 2000;
          this.clientLog(
            "warn",
            `retryable error (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMsg}, retrying in ${delayMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw error;
      }
    }

    throw new Error("unreachable");
  }

  private async executeComplete(
    messages: ConversationMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const gatewayMessages = this.buildGatewayMessages(messages);

    const systemMessage = messages.find((message) => message.role === "system");
    const systemPrompt = options?.systemPrompt ?? systemMessage?.content;

    this.clientLog(
      "info",
      `complete: model=${options?.model ?? this.model}, messages=${gatewayMessages.length}`,
    );

    const response = await this.gatewayClient.complete({
      model: options?.model ?? this.model,
      messages: gatewayMessages,
      temperature: options?.temperature ?? this.defaultTemperature,
      maxTokens: options?.maxTokens ?? this.defaultMaxTokens,
      systemPrompt,
      tools: options?.noTools ? [] : (this.buildGatewayTools() ?? []),
      provider: this.provider,
    });

    this.tokenUsage.totalPromptTokens += response.promptTokens;
    this.tokenUsage.totalCompletionTokens += response.completionTokens;
    this.tokenUsage.requestCount += 1;

    const toolCalls: ToolCallEntry[] = (response.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: {
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      },
    }));

    const finishReason = response.finishReason || "stop";
    this.clientLog(
      "info",
      `complete finished: finishReason=${finishReason}, toolCalls=${toolCalls.length}, contentLength=${(response.message?.content ?? "").length}, promptTokens=${response.promptTokens}, completionTokens=${response.completionTokens}`,
    );

    return {
      id: response.id,
      model: response.model,
      content: response.message?.content ?? "",
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      toolCalls,
      finishReason,
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

    if (result.toolCalls.length > 0) {
      conversation.addAssistantToolCallMessage(result.content, result.toolCalls);
    } else {
      conversation.addAssistantMessage(result.content);
    }
    return result;
  }

  async streamConversation(
    conversation: ConversationHistory,
    userMessage: string,
    onDelta: StreamDeltaCallback,
    options?: CompletionOptions,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    conversation.addUserMessage(userMessage);

    try {
      return await this.executeStreamConversation(conversation, onDelta, options, signal);
    } catch (streamError) {
      if (signal?.aborted) throw streamError;
      const streamErrorMsg =
        streamError instanceof Error ? streamError.message : String(streamError);
      this.clientLog("warn", `streaming failed, falling back to non-streaming: ${streamErrorMsg}`);
      try {
        const messages = conversation.getMessagesWithSystemPrompt();
        const result = await this.complete(messages, options);
        if (result.toolCalls.length > 0) {
          conversation.addAssistantToolCallMessage(result.content, result.toolCalls);
        } else {
          conversation.addAssistantMessage(result.content);
        }
        onDelta({
          content: result.content,
          done: true,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
        });
        return result;
      } catch (fallbackError) {
        const fallbackMsg =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        this.clientLog("error", `non-streaming fallback also failed: ${fallbackMsg}`);
        throw new Error(
          `streaming failed (${streamErrorMsg}), non-streaming fallback also failed: ${fallbackMsg}`,
        );
      }
    }
  }

  private async executeStreamConversation(
    conversation: ConversationHistory,
    onDelta: StreamDeltaCallback,
    options?: CompletionOptions,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const allMessages = conversation.getMessagesWithSystemPrompt();

    const gatewayMessages = this.buildGatewayMessages(allMessages);
    this.clientLog("info", `stream: model=${this.model}, messages=${gatewayMessages.length}`);

    const systemMessage = allMessages.find((message) => message.role === "system");
    const systemPrompt = options?.systemPrompt ?? systemMessage?.content;

    const stream = this.gatewayClient.streamComplete(
      {
        model: this.model,
        messages: gatewayMessages,
        temperature: options?.temperature ?? this.defaultTemperature,
        maxTokens: options?.maxTokens ?? this.defaultMaxTokens,
        systemPrompt,
        tools: this.buildGatewayTools() ?? [],
        provider: this.provider,
      },
      signal ? { signal } : undefined,
    );

    let fullContent = "";
    let fullReasoning = "";
    let toolCalls: ToolCallEntry[] = [];
    let finishReason = "stop";
    let streamPromptTokens = 0;
    let streamCompletionTokens = 0;

    const iterator = stream[Symbol.asyncIterator]();
    const timeoutMs = options?.streamTimeoutMs ?? 60_000;

    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let inactivityReject: ((reason: Error) => void) | null = null;

    function resetInactivityTimeout() {
      if (inactivityTimer !== null) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (inactivityReject) inactivityReject(new Error("stream inactivity timeout"));
      }, timeoutMs);
    }

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (inactivityTimer !== null) clearTimeout(inactivityTimer);
        },
        { once: true },
      );
    }

    while (true) {
      if (signal?.aborted) break;

      resetInactivityTimeout();

      const timeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) => {
        inactivityReject = reject;
      });

      let result: IteratorResult<typeof stream extends AsyncIterable<infer T> ? T : never>;
      try {
        result = (await Promise.race([iterator.next(), timeoutPromise])) as typeof result;
      } catch (raceError) {
        if (signal?.aborted) break;
        if (raceError instanceof Error && raceError.message === "stream inactivity timeout") {
          this.clientLog(
            "error",
            `stream inactivity timeout after ${timeoutMs}ms — ending stream with partial content (${fullContent.length} chars)`,
          );
          onDelta({ content: "", done: true });
          break;
        }
        throw raceError;
      }

      if (result.done) break;

      const chunk = result.value;
      fullContent += chunk.delta;
      if (chunk.reasoning) {
        fullReasoning += chunk.reasoning;
      }
      onDelta({ content: chunk.delta, reasoning: chunk.reasoning || undefined, done: chunk.done });

      if (chunk.promptTokens > 0) {
        this.tokenUsage.totalPromptTokens += chunk.promptTokens;
        streamPromptTokens += chunk.promptTokens;
      }
      if (chunk.completionTokens > 0) {
        this.tokenUsage.totalCompletionTokens += chunk.completionTokens;
        streamCompletionTokens += chunk.completionTokens;
      }

      if (chunk.done) {
        finishReason = chunk.finishReason || "stop";
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          toolCalls = chunk.toolCalls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          }));
        }
        break;
      }
    }

    if (inactivityTimer !== null) clearTimeout(inactivityTimer);

    if (toolCalls.length > 0) {
      conversation.addAssistantToolCallMessage(fullContent, toolCalls);
    } else {
      conversation.addAssistantMessage(fullContent);
    }

    this.tokenUsage.requestCount += 1;

    return {
      id: "",
      model: this.model,
      content: fullContent,
      reasoning: fullReasoning || undefined,
      promptTokens: streamPromptTokens,
      completionTokens: streamCompletionTokens,
      toolCalls,
      finishReason,
    };
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
      noTools: true,
    });

    return result.content;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getProvider(): string {
    return this.provider;
  }

  setProvider(provider: string): void {
    this.provider = provider;
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
