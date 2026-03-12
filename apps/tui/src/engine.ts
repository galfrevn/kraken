import { LanguageModelClient } from "@core/language/client.ts";
import { ConversationHistory } from "@core/language/conversation.ts";
import { ToolRegistry } from "@core/tools/registry.ts";
import { buildSystemPrompt, type PromptOptions } from "@core/agent/prompt.ts";
import { toolsToNativeFormat } from "@core/tools/schema.ts";
import type { ToolExecutionContext } from "@core/tools/schema.ts";
import type { CompletionResult, ToolCallEntry } from "@core/language/schema.ts";
import type { HookDispatcher } from "@core/plugins/hooks.ts";
import type { PluginContext } from "@kraken/sdk";

const MAX_ITERATIONS_PER_MESSAGE = 40;
const CONTINUE_PROMPT = "Continue from where you left off. Complete any remaining steps without repeating what was already done.";

export type ChatMessageRole = "user" | "assistant" | "tool_call" | "tool_result" | "error" | "status";

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  rawContent?: string;
  timestamp: Date;
  toolName?: string;
  toolSuccess?: boolean;
  streaming?: boolean;
}

export interface SerializedChatMessage {
  role: ChatMessageRole;
  content: string;
  rawContent?: string;
  timestamp: string;
  toolName?: string;
  toolSuccess?: boolean;
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
  private processingQueue: boolean = false;
  private reachedIterationLimit: boolean = false;
  private hookDispatcher?: HookDispatcher;
  private pluginContext?: PluginContext;

  constructor(
    languageModelClient: LanguageModelClient,
    toolRegistry: ToolRegistry,
    workingDirectory: string,
    promptOptions?: PromptOptions,
  ) {
    this.languageModelClient = languageModelClient;
    this.toolRegistry = toolRegistry;
    this.workingDirectory = workingDirectory;

    const systemPrompt = buildSystemPrompt(this.toolRegistry.listTools(), promptOptions);
    this.conversation = new ConversationHistory(systemPrompt);

    this.languageModelClient.setNativeTools(toolsToNativeFormat(this.toolRegistry.listTools()));
  }

  setHookDispatcher(dispatcher: HookDispatcher, context: PluginContext): void {
    this.hookDispatcher = dispatcher;
    this.pluginContext = context;
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

  addEventListener(listener: ChatEventListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(listener: ChatEventListener): void {
    this.listeners.delete(listener);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  cancelCurrentResponse(): boolean {
    if (!this.processing || !this.abortController) return false;

    this.abortController.abort();
    return true;
  }

  enqueueMessage(userInput: string): void {
    if (!userInput.trim()) return;

    if (!this.processing) {
      this.processMessage(userInput);
      return;
    }

    this.messageQueue.push(userInput);
    this.emit();
  }

  private async processNextInQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.messageQueue.length > 0) {
      const nextMessage = this.messageQueue.shift()!;
      await this.processMessage(nextMessage);
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
    }));

    this.conversation.clear();
    for (const conversationMessage of state.conversationMessages) {
      if (conversationMessage.role === "user") {
        this.conversation.addUserMessage(conversationMessage.content);
      } else if (conversationMessage.role === "assistant") {
        if (conversationMessage.toolCalls && conversationMessage.toolCalls.length > 0) {
          this.conversation.addAssistantToolCallMessage(conversationMessage.content, conversationMessage.toolCalls);
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
      this.messages[lastIndex] = updater(lastMessage);
      this.emit();
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

      if (!completionResult.content.trim() && completionResult.toolCalls.length === 0) {
        this.removeLastMessage();
      }

      return completionResult;
    } catch (streamError) {
      this.removeLastMessage();
      throw streamError;
    }
  }

  async sendMessage(userInput: string): Promise<void> {
    this.enqueueMessage(userInput);
  }

  private async processMessage(userInput: string): Promise<void> {
    if (this.processing) return;

    this.processing = true;
    this.abortController = new AbortController();
    this.emitImmediate();

    this.pushMessage({
      role: "user",
      content: userInput,
      timestamp: new Date(),
    });

    const toolContext: ToolExecutionContext = {
      workingDirectory: this.workingDirectory,
    };

    if (this.hookDispatcher && this.pluginContext) {
      await this.hookDispatcher.dispatchConversationStart(this.pluginContext).catch(() => {});
    }

    try {
      let completionResult = await this.getResponse(userInput);
      let iterations = 0;

      while (iterations < MAX_ITERATIONS_PER_MESSAGE) {
        this.checkCancelled();
        iterations += 1;

        if (completionResult.finishReason !== "tool_calls" || completionResult.toolCalls.length === 0) {
          break;
        }

        // Only remove the assistant message if it has no visible text content
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg && lastMsg.role === "assistant" && !lastMsg.content.trim()) {
          this.removeLastMessage();
        }

        for (const toolCall of completionResult.toolCalls) {
          this.checkCancelled();

          let parameters: Record<string, unknown>;
          try {
            parameters = JSON.parse(toolCall.function.arguments);
          } catch {
            parameters = {};
          }

          if (this.hookDispatcher) {
            parameters = await this.hookDispatcher.dispatchBeforeToolCall(toolCall.function.name, parameters);
          }

          this.pushMessage({
            role: "tool_call",
            content: JSON.stringify(parameters, null, 2),
            toolName: toolCall.function.name,
            timestamp: new Date(),
          });

          try {
            const toolResult = await this.raceWithAbort(
              this.toolRegistry.executeTool(
                toolCall.function.name,
                parameters,
                toolContext,
              ),
            );

            if (this.hookDispatcher) {
              await this.hookDispatcher.dispatchAfterToolCall(toolCall.function.name, parameters, toolResult);
            }

            const resultPreview = toolResult.output.length > 3000
              ? toolResult.output.slice(0, 3000) + "..."
              : toolResult.output;

            this.pushMessage({
              role: "tool_result",
              content: resultPreview,
              rawContent: toolResult.output,
              toolName: toolCall.function.name,
              toolSuccess: toolResult.success,
              timestamp: new Date(),
            });

            this.conversation.addToolResultMessage(
              toolCall.id,
              toolCall.function.name,
              toolResult.success ? toolResult.output : (toolResult.error ?? toolResult.output),
            );
          } catch (toolError) {
            if (toolError instanceof CancelledError) throw toolError;

            const toolErrorMessage = toolError instanceof Error
              ? toolError.message
              : String(toolError);

            this.pushMessage({
              role: "tool_result",
              content: toolErrorMessage,
              rawContent: toolErrorMessage,
              toolName: toolCall.function.name,
              toolSuccess: false,
              timestamp: new Date(),
            });

            this.conversation.addToolResultMessage(
              toolCall.id,
              toolCall.function.name,
              toolErrorMessage,
            );
          }
        }

        try {
          completionResult = await this.getResponseContinuation();
        } catch (followUpError) {
          if (followUpError instanceof CancelledError) throw followUpError;
          this.pushMessage({
            role: "status",
            content: "could not get follow-up response",
            timestamp: new Date(),
          });
          break;
        }
      }

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
        const errorMessage = executionError instanceof Error
          ? executionError.message
          : String(executionError);
        this.pushMessage({
          role: "error",
          content: errorMessage,
          timestamp: new Date(),
        });
      }
    } finally {
      if (this.hookDispatcher && this.pluginContext) {
        await this.hookDispatcher.dispatchConversationEnd(this.pluginContext).catch(() => {});
      }

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

    this.pushMessage({
      role: "assistant",
      content: "",
      timestamp: new Date(),
      streaming: true,
    });

    try {
      const messages = this.conversation.getMessagesWithSystemPrompt();
      const completionResult = await this.languageModelClient.complete(messages);

      this.checkCancelled();

      if (completionResult.toolCalls.length > 0) {
        this.conversation.addAssistantToolCallMessage(completionResult.content, completionResult.toolCalls);
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
    this.emitImmediate();
  }

  getTokenUsage() {
    return this.languageModelClient.getTokenUsage();
  }
}
