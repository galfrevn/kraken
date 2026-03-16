import { LanguageModelClient } from "@core/language/client.ts";
import { ConversationHistory } from "@core/language/conversation.ts";
import { ToolRegistry } from "@core/tools/registry.ts";
import { buildSystemPrompt, type PromptOptions } from "@core/agent/prompt.ts";
import { toolsToNativeFormat } from "@core/tools/schema.ts";
import { performTieredCompaction, type CompactionResult } from "@core/language/compaction.ts";
import type { ToolExecutionContext } from "@core/tools/schema.ts";
import type { CompletionResult, ToolCallEntry, TokenUsageSummary } from "@core/language/schema.ts";

const MAX_ITERATIONS_PER_MESSAGE = 40;
const CONTINUE_PROMPT =
  "Continue from where you left off. Complete any remaining steps without repeating what was already done.";

export type ChatMessageRole =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "error"
  | "status";

export interface FileAttachment {
  path: string;
  name: string;
  isImage: boolean;
}

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  rawContent?: string;
  timestamp: Date;
  toolName?: string;
  toolSuccess?: boolean;
  streaming?: boolean;
  attachments?: FileAttachment[];
}

export interface DebugLogEntry {
  timestamp: Date;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
}

export interface SerializedChatMessage {
  role: ChatMessageRole;
  content: string;
  rawContent?: string;
  timestamp: string;
  toolName?: string;
  toolSuccess?: boolean;
  attachments?: FileAttachment[];
}

export interface SerializedConversationMessage {
  role: string;
  content: string;
  toolCalls?: ToolCallEntry[];
  toolCallId?: string;
  name?: string;
}

export interface SerializedChatEngine {
  messages: SerializedChatMessage[];
  conversationMessages: SerializedConversationMessage[];
}

export type ChatEventListener = (messages: ChatMessage[]) => void;

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export class ChatEngine {
  private languageModelClient: LanguageModelClient;
  private toolRegistry: ToolRegistry;
  private conversation: ConversationHistory;
  private messages: ChatMessage[] = [];
  private listeners: Set<ChatEventListener> = new Set();
  private processing: boolean = false;
  private workingDirectory: string;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private messageQueue: string[] = [];
  private pendingAttachments: (FileAttachment[] | undefined)[] = [];
  private processingQueue: boolean = false;
  private reachedIterationLimit: boolean = false;
  private promptOptions: PromptOptions;
  private tokenUsage: TokenUsageSummary = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    requestCount: 0,
  };
  private debugLog: DebugLogEntry[] = [];
  private logPersister?: (level: string, source: string, message: string) => void;

  constructor(
    languageModelClient: LanguageModelClient,
    toolRegistry: ToolRegistry,
    workingDirectory: string,
    promptOptions?: PromptOptions,
  ) {
    this.languageModelClient = languageModelClient;
    this.toolRegistry = toolRegistry;
    this.workingDirectory = workingDirectory;
    this.promptOptions = promptOptions ?? {};

    const systemPrompt = buildSystemPrompt(this.toolRegistry.listTools(), this.promptOptions);
    this.conversation = new ConversationHistory(systemPrompt, { maxMessages: 80 });

    this.languageModelClient.setNativeTools(toolsToNativeFormat(this.toolRegistry.listTools()));
    this.languageModelClient.setLogCallback((level, message) => {
      this.log(level, "llm", message);
    });
  }

  private log(level: DebugLogEntry["level"], source: string, message: string): void {
    this.debugLog.push({ timestamp: new Date(), level, source, message });
    if (this.debugLog.length > 500) {
      this.debugLog = this.debugLog.slice(-400);
    }
    this.logPersister?.(level, source, message);
  }

  getDebugLog(): readonly DebugLogEntry[] {
    return this.debugLog;
  }

  setLogPersister(persister: (level: string, source: string, message: string) => void): void {
    this.logPersister = persister;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  getQueueLength(): number {
    return this.messageQueue.length;
  }

  getQueuedMessages(): string[] {
    return [...this.messageQueue];
  }

  addEventListener(listener: ChatEventListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(listener: ChatEventListener): void {
    this.listeners.delete(listener);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  private async executeToolCall(
    toolCall: ToolCallEntry,
    parameters: Record<string, unknown>,
    toolContext: ToolExecutionContext,
  ): Promise<{
    toolCall: ToolCallEntry;
    parameters: Record<string, unknown>;
    toolResult: import("@core/tools/schema.ts").ToolResult | null;
    error: string | null;
  }> {
    const isDelegateToolCall = toolCall.function.name === "delegate";
    const contextWithProgress: ToolExecutionContext = isDelegateToolCall
      ? {
          ...toolContext,
          onProgress: (progressEvent) => {
            if (progressEvent.type === "start") {
              this.pushMessage({
                role: "status",
                content: `subagent: ${progressEvent.message ?? "starting"}`,
                timestamp: new Date(),
              });
            } else if (progressEvent.type === "tool_call" && progressEvent.toolName) {
              this.updateLastStatusMessage(`subagent: calling ${progressEvent.toolName}`);
            } else if (progressEvent.type === "iteration" && progressEvent.iterationNumber) {
              this.updateLastStatusMessage(`subagent: iteration ${progressEvent.iterationNumber}`);
            } else if (progressEvent.type === "complete") {
              this.updateLastStatusMessage(`subagent: ${progressEvent.message ?? "done"}`);
            }
          },
        }
      : toolContext;

    try {
      const toolResult = await this.raceWithAbort(
        this.toolRegistry.executeTool(toolCall.function.name, parameters, contextWithProgress),
      );

      return { toolCall, parameters, toolResult, error: null };
    } catch (toolError) {
      if (toolError instanceof CancelledError) throw toolError;
      const toolErrorMessage = toolError instanceof Error ? toolError.message : String(toolError);
      return { toolCall, parameters, toolResult: null, error: toolErrorMessage };
    }
  }

  private updateLastStatusMessage(content: string): void {
    for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex--) {
      if (this.messages[messageIndex]!.role === "status") {
        this.messages[messageIndex] = { ...this.messages[messageIndex]!, content };
        this.emit();
        return;
      }
    }
    this.pushMessage({ role: "status", content, timestamp: new Date() });
  }

  cancelCurrentResponse(): boolean {
    if (!this.processing || !this.abortController) return false;

    this.abortController.abort();
    return true;
  }

  enqueueMessage(userInput: string, attachments?: FileAttachment[]): void {
    if (!userInput.trim()) return;

    if (!this.processing) {
      this.processMessage(userInput, attachments);
      return;
    }

    this.messageQueue.push(userInput);
    this.pendingAttachments.push(attachments);
    this.emit();
  }

  private async processNextInQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.messageQueue.length > 0) {
      const nextMessage = this.messageQueue.shift()!;
      const nextAttachments = this.pendingAttachments.shift();
      await this.processMessage(nextMessage, nextAttachments);
    }

    this.processingQueue = false;
  }

  private emit(): void {
    if (this.emitTimer !== null) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const snapshot = this.messages;
      for (const listener of this.listeners) {
        listener(snapshot);
      }
    }, 16);
  }

  private emitImmediate(): void {
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    const snapshot = this.messages;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  exportState(): SerializedChatEngine {
    return {
      messages: this.messages
        .filter((message) => !message.streaming)
        .map((message) => ({
          role: message.role,
          content: message.content,
          rawContent: message.rawContent,
          timestamp: message.timestamp.toISOString(),
          toolName: message.toolName,
          toolSuccess: message.toolSuccess,
          attachments: message.attachments,
        })),
      conversationMessages: this.conversation.getMessages().map((message) => ({
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        name: message.name,
      })),
    };
  }

  importState(state: SerializedChatEngine): void {
    this.messages = state.messages.map((message) => ({
      role: message.role,
      content: message.content,
      rawContent: message.rawContent,
      timestamp: new Date(message.timestamp),
      toolName: message.toolName,
      toolSuccess: message.toolSuccess,
      attachments: message.attachments,
    }));

    this.conversation.clear();
    for (const conversationMessage of state.conversationMessages) {
      if (conversationMessage.role === "user") {
        this.conversation.addUserMessage(conversationMessage.content);
      } else if (conversationMessage.role === "assistant") {
        if (conversationMessage.toolCalls && conversationMessage.toolCalls.length > 0) {
          this.conversation.addAssistantToolCallMessage(
            conversationMessage.content,
            conversationMessage.toolCalls,
          );
        } else {
          this.conversation.addAssistantMessage(conversationMessage.content);
        }
      } else if (conversationMessage.role === "tool") {
        this.conversation.addToolResultMessage(
          conversationMessage.toolCallId ?? "",
          conversationMessage.name ?? "",
          conversationMessage.content,
        );
      }
    }

    this.emitImmediate();
  }

  private pushMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.emit();
  }

  private removeLastMessage(): void {
    this.messages.pop();
    this.emit();
  }

  private updateLastMessage(updater: (message: ChatMessage) => ChatMessage): void {
    const lastIndex = this.messages.length - 1;
    const lastMessage = this.messages[lastIndex];
    if (lastIndex >= 0 && lastMessage) {
      const updated = updater(lastMessage);
      this.messages[lastIndex] = updated;
      if (lastMessage.streaming && !updated.streaming) {
        this.emitImmediate();
      } else {
        this.emit();
      }
    }
  }

  private checkCancelled(): void {
    if (this.abortController?.signal.aborted) {
      throw new CancelledError();
    }
  }

  private raceWithAbort<T>(operation: Promise<T>): Promise<T> {
    const signal = this.abortController?.signal;
    if (signal?.aborted) return Promise.reject(new CancelledError());

    if (!signal) return operation;

    return Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new CancelledError()), { once: true });
      }),
    ]);
  }

  private async getResponse(inputMessage: string): Promise<CompletionResult> {
    this.checkCancelled();
    this.log(
      "info",
      "engine",
      `getResponse: starting streamed response (conversationLength=${this.conversation.getMessageCount()})`,
    );

    this.pushMessage({
      role: "assistant",
      content: "",
      timestamp: new Date(),
      streaming: true,
    });

    try {
      let accumulatedReasoning = "";
      let reasoningDirty = false;
      let cachedRawPrefix = "";

      {
        const compactResult = this.conversation.compactIfNeeded();
        if (compactResult.didCompact) {
          this.log(
            "warn",
            "engine",
            `conversation compacted: removed ${compactResult.removedCount} messages, ${this.conversation.getMessageCount()} remaining`,
          );
        }
      }

      const completionResult = await this.languageModelClient.streamConversation(
        this.conversation,
        inputMessage,
        (delta) => {
          if (this.abortController?.signal.aborted) return;

          if (delta.reasoning) {
            accumulatedReasoning += delta.reasoning;
            reasoningDirty = true;
          }

          this.updateLastMessage((message) => {
            const content = message.content + delta.content;
            if (reasoningDirty) {
              cachedRawPrefix = `<thinking>${accumulatedReasoning}</thinking>\n\n`;
              reasoningDirty = false;
            }
            return {
              ...message,
              content,
              rawContent: cachedRawPrefix ? cachedRawPrefix + content : undefined,
              streaming: !delta.done,
            };
          });
        },
        undefined,
        this.abortController?.signal,
      );

      this.checkCancelled();

      const reasoningPrefix = accumulatedReasoning
        ? `<thinking>${accumulatedReasoning}</thinking>\n\n`
        : "";

      this.updateLastMessage((message) => ({
        ...message,
        streaming: false,
        rawContent: reasoningPrefix + completionResult.content,
      }));

      this.trackTokenUsage(completionResult);

      if (!completionResult.content.trim() && completionResult.toolCalls.length === 0) {
        this.removeLastMessage();
      }

      return completionResult;
    } catch (streamError) {
      this.log(
        "error",
        "engine",
        `getResponse failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
      );
      this.removeLastMessage();
      throw streamError;
    }
  }

  async sendMessage(userInput: string, attachments?: FileAttachment[]): Promise<void> {
    this.enqueueMessage(userInput, attachments);
  }

  private async processMessage(userInput: string, attachments?: FileAttachment[]): Promise<void> {
    if (this.processing) return;

    this.processing = true;
    this.abortController = new AbortController();
    this.emitImmediate();

    this.pushMessage({
      role: "user",
      content: userInput,
      timestamp: new Date(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    });

    const toolContext: ToolExecutionContext = {
      workingDirectory: this.workingDirectory,
    };

    this.log(
      "info",
      "engine",
      `processing message (queueLength=${this.messageQueue.length})`,
    );

    try {
      let llmInput = userInput;
      if (attachments && attachments.length > 0) {
        const attachmentLines = attachments.map((attachment) =>
          attachment.isImage
            ? `[Attached image: ${attachment.path}] (use view_image tool to analyze)`
            : `[Attached file: ${attachment.path}] (use read_file tool to read)`,
        );
        llmInput = llmInput + "\n\n" + attachmentLines.join("\n");
      }

      let completionResult = await this.getResponse(llmInput);
      this.log(
        "info",
        "engine",
        `initial response: finishReason=${completionResult.finishReason}, toolCalls=${completionResult.toolCalls.length}, contentLength=${completionResult.content.length}`,
      );

      if (
        completionResult.finishReason === "tool_calls" &&
        completionResult.toolCalls.length === 0
      ) {
        this.log(
          "warn",
          "engine",
          `finishReason was tool_calls but no tool calls found — normalizing to stop`,
        );
        completionResult.finishReason = "stop";
      }

      let iterations = 0;

      while (iterations < MAX_ITERATIONS_PER_MESSAGE) {
        this.checkCancelled();
        iterations += 1;

        if (
          completionResult.finishReason !== "tool_calls" ||
          completionResult.toolCalls.length === 0
        ) {
          this.log(
            "info",
            "engine",
            `loop exiting: finishReason=${completionResult.finishReason}, toolCalls=${completionResult.toolCalls.length}, iterations=${iterations}`,
          );
          break;
        }

        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && lastMessage.role === "assistant" && !lastMessage.content.trim()) {
          this.removeLastMessage();
        }

        this.log(
          "info",
          "engine",
          `iteration ${iterations}: executing ${completionResult.toolCalls.length} tool call(s): ${completionResult.toolCalls.map((toolCallEntry) => toolCallEntry.function.name).join(", ")}`,
        );
        const preparedCalls = await Promise.all(
          completionResult.toolCalls.map(async (toolCallEntry) => {
            let parameters: Record<string, unknown>;
            try {
              parameters = JSON.parse(toolCallEntry.function.arguments);
            } catch (parseError) {
              this.log(
                "warn",
                "engine",
                `failed to parse parameters for ${toolCallEntry.function.name}: ${parseError instanceof Error ? parseError.message : String(parseError)}, raw: ${toolCallEntry.function.arguments.slice(0, 200)}`,
              );
              parameters = {};
            }

            this.pushMessage({
              role: "tool_call",
              content: JSON.stringify(parameters, null, 2),
              toolName: toolCallEntry.function.name,
              timestamp: new Date(),
            });

            return { toolCall: toolCallEntry, parameters };
          }),
        );

        this.checkCancelled();

        const results = await Promise.all(
          preparedCalls.map(({ toolCall, parameters }) =>
            this.executeToolCall(toolCall, parameters, toolContext),
          ),
        );

        for (const { toolCall, toolResult, error } of results) {
          if (toolResult) {
            const resultText = toolResult.success
              ? toolResult.output
              : (toolResult.error ?? toolResult.output);
            const resultPreview =
              resultText.length > 3000 ? resultText.slice(0, 3000) + "..." : resultText;

            this.pushMessage({
              role: "tool_result",
              content: resultPreview,
              rawContent: resultText,
              toolName: toolCall.function.name,
              toolSuccess: toolResult.success,
              timestamp: new Date(),
            });

            this.conversation.addToolResultMessage(toolCall.id, toolCall.function.name, resultText);

            if (!toolResult.success) {
              this.log("error", "tool", `${toolCall.function.name}: ${resultText}`);
            }
          } else {
            this.pushMessage({
              role: "tool_result",
              content: error!,
              rawContent: error!,
              toolName: toolCall.function.name,
              toolSuccess: false,
              timestamp: new Date(),
            });

            this.log("error", "tool", `${toolCall.function.name} execution failed: ${error}`);

            this.conversation.addToolResultMessage(toolCall.id, toolCall.function.name, error!);
          }
        }

        try {
          completionResult = await this.getResponseContinuation();
          if (
            completionResult.finishReason === "tool_calls" &&
            completionResult.toolCalls.length === 0
          ) {
            this.log(
              "warn",
              "engine",
              `continuation finishReason was tool_calls but no tool calls found — normalizing to stop`,
            );
            completionResult.finishReason = "stop";
          }
          this.log(
            "info",
            "engine",
            `continuation response: finishReason=${completionResult.finishReason}, toolCalls=${completionResult.toolCalls.length}, contentLength=${completionResult.content.length}`,
          );
        } catch (followUpError) {
          if (followUpError instanceof CancelledError) throw followUpError;
          const errorDetail =
            followUpError instanceof Error ? followUpError.message : String(followUpError);
          this.pushMessage({
            role: "error",
            content: `follow-up response failed: ${errorDetail}`,
            timestamp: new Date(),
          });
          this.log("error", "llm", `follow-up response failed: ${errorDetail}`);
          break;
        }
      }

      this.log(
        "info",
        "engine",
        `message processing complete: ${iterations} iterations`,
      );

      if (iterations >= MAX_ITERATIONS_PER_MESSAGE) {
        this.reachedIterationLimit = true;
        this.pushMessage({
          role: "status",
          content: "reached maximum iterations — type /continue to resume",
          timestamp: new Date(),
        });
      }
    } catch (executionError) {
      if (executionError instanceof CancelledError) {
        this.log("info", "engine", "response cancelled by user");
        this.updateLastMessage((message) => ({
          ...message,
          streaming: false,
        }));

        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && lastMessage.role === "assistant" && !lastMessage.content.trim()) {
          this.removeLastMessage();
        }

        this.pushMessage({
          role: "status",
          content: "response cancelled",
          timestamp: new Date(),
        });
      } else {
        const errorMessage =
          executionError instanceof Error ? executionError.message : String(executionError);
        const errorStack = executionError instanceof Error ? (executionError.stack ?? "") : "";
        this.pushMessage({
          role: "error",
          content: errorMessage,
          timestamp: new Date(),
        });
        this.log("error", "engine", `execution error: ${errorMessage}`);
        if (errorStack) {
          this.log("error", "engine", `stack: ${errorStack.slice(0, 500)}`);
        }
      }
    } finally {
      this.log(
        "info",
        "engine",
        `processMessage finished (queueRemaining=${this.messageQueue.length})`,
      );
      this.processing = false;
      this.abortController = null;
      this.emitImmediate();

      if (this.messageQueue.length > 0) {
        queueMicrotask(() => this.processNextInQueue());
      }
    }
  }

  private async getResponseContinuation(): Promise<CompletionResult> {
    this.checkCancelled();
    this.log(
      "info",
      "engine",
      `getResponseContinuation: requesting follow-up (conversationLength=${this.conversation.getMessageCount()})`,
    );

    this.pushMessage({
      role: "assistant",
      content: "",
      timestamp: new Date(),
      streaming: true,
    });

    try {
      {
        const compactResult = this.conversation.compactIfNeeded();
        if (compactResult.didCompact) {
          this.log(
            "warn",
            "engine",
            `conversation compacted: removed ${compactResult.removedCount} messages, ${this.conversation.getMessageCount()} remaining`,
          );
        }
      }
      const conversationMessages = this.conversation.getMessagesWithSystemPrompt();
      const completionResult = await this.languageModelClient.complete(conversationMessages);
      this.trackTokenUsage(completionResult);

      this.checkCancelled();

      if (completionResult.toolCalls.length > 0) {
        this.conversation.addAssistantToolCallMessage(
          completionResult.content,
          completionResult.toolCalls,
        );
      } else {
        this.conversation.addAssistantMessage(completionResult.content);
      }

      const reasoningPrefix = completionResult.reasoning
        ? `<thinking>${completionResult.reasoning}</thinking>\n\n`
        : "";

      this.updateLastMessage((message) => ({
        ...message,
        content: completionResult.content,
        streaming: false,
        rawContent: reasoningPrefix + completionResult.content,
      }));

      if (!completionResult.content.trim() && completionResult.toolCalls.length === 0) {
        this.removeLastMessage();
      }

      return completionResult;
    } catch (error) {
      this.log(
        "error",
        "engine",
        `getResponseContinuation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.removeLastMessage();
      throw error;
    }
  }

  hasReachedIterationLimit(): boolean {
    return this.reachedIterationLimit;
  }

  continueFromLimit(): void {
    if (!this.reachedIterationLimit) return;
    this.reachedIterationLimit = false;
    this.processMessage(CONTINUE_PROMPT);
  }

  clearHistory(): void {
    this.messages = [];
    this.conversation.clear();
    this.messageQueue = [];
    this.pendingAttachments = [];
    this.emitImmediate();
  }

  private trackTokenUsage(result: CompletionResult): void {
    this.tokenUsage.totalPromptTokens += result.promptTokens;
    this.tokenUsage.totalCompletionTokens += result.completionTokens;
    this.tokenUsage.requestCount += 1;
  }

  getTokenUsage(): TokenUsageSummary {
    return { ...this.tokenUsage };
  }

  getConversation(): ConversationHistory {
    return this.conversation;
  }

  getLanguageModelClient(): LanguageModelClient {
    return this.languageModelClient;
  }

  async triggerCompaction(maximumContextTokens: number = 128_000): Promise<CompactionResult> {
    const compactionResult = await performTieredCompaction(
      this.conversation,
      this.languageModelClient,
      maximumContextTokens,
    );

    if (compactionResult.tier !== "none") {
      this.pushMessage({
        role: "status",
        content: `compacted (${compactionResult.tier}): ${compactionResult.tokensBeforeCompaction.toLocaleString()} → ${compactionResult.tokensAfterCompaction.toLocaleString()} tokens`,
        timestamp: new Date(),
      });
    }

    return compactionResult;
  }
}
