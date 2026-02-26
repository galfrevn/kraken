import { LanguageModelClient } from "@core/language/client.ts";
import { ConversationHistory } from "@core/language/conversation.ts";
import { ToolRegistry } from "@core/tools/registry.ts";
import { buildSystemPrompt, type PromptOptions } from "@core/agent/prompt.ts";
import { parseAgentResponse, formatToolResultForConversation } from "@core/agent/parser.ts";
import type { ToolExecutionContext } from "@core/tools/schema.ts";
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
  private emitScheduled: boolean = false;
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
    if (this.emitScheduled) return;
    this.emitScheduled = true;

    queueMicrotask(() => {
      this.emitScheduled = false;
      const snapshot = this.messages;
      for (const listener of this.listeners) {
        listener(snapshot);
      }
    });
  }

  private emitImmediate(): void {
    this.emitScheduled = false;
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
        this.conversation.addAssistantMessage(conversationMessage.content);
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

  private async getResponse(inputMessage: string): Promise<string> {
    this.checkCancelled();

    this.pushMessage({
      role: "assistant",
      content: "",
      timestamp: new Date(),
      streaming: true,
    });

    try {
      const fullContent = await this.languageModelClient.streamConversation(
        this.conversation,
        inputMessage,
        (delta) => {
          if (this.abortController?.signal.aborted) return;

          this.updateLastMessage((message) => ({
            ...message,
            content: message.content + delta.content,
            streaming: !delta.done,
          }));
        },
        undefined,
        this.abortController?.signal,
      );

      this.checkCancelled();

      this.updateLastMessage((message) => ({
        ...message,
        streaming: false,
        rawContent: fullContent,
      }));

      if (!fullContent.trim()) {
        this.removeLastMessage();
      }

      return fullContent;
    } catch (streamError) {
      this.removeLastMessage();
      throw streamError;
    }
  }

  private async continueResponse(): Promise<string | undefined> {
    this.checkCancelled();

    try {
      const continuationContent = await this.languageModelClient.streamConversation(
        this.conversation,
        "Your previous response was truncated. Continue exactly from where you stopped — if you were mid-tool_call, complete that tag first.",
        (delta) => {
          if (this.abortController?.signal.aborted) return;

          this.updateLastMessage((message) => ({
            ...message,
            content: message.content + delta.content,
            streaming: !delta.done,
          }));
        },
        undefined,
        this.abortController?.signal,
      );

      this.updateLastMessage((message) => ({
        ...message,
        streaming: false,
      }));

      return continuationContent;
    } catch {
      return undefined;
    }
  }

  private cleanAssistantContent(rawContent: string): string {
    return rawContent
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .replace(/<tool_call>[\s\S]*$/g, "")
      .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
      .replace(/<function_calls>[\s\S]*$/g, "")
      .replace(/<tool_result[\s\S]*?<\/tool_result>/g, "")
      .replace(/<tool_result[\s\S]*$/g, "")
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
      .replace(/<thinking>[\s\S]*$/g, "")
      .trim();
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
      let currentResponse = await this.getResponse(userInput);
      let iterations = 0;

      while (iterations < MAX_ITERATIONS_PER_MESSAGE) {
        this.checkCancelled();
        iterations += 1;
        let parsed = parseAgentResponse(currentResponse);

        if (parsed.truncated) {
          const continued = await this.continueResponse();
          if (continued) {
            currentResponse = currentResponse + continued;
            parsed = parseAgentResponse(currentResponse);
          }
        }

        if (parsed.finalResult) {
          this.updateLastMessage((message) => ({
            ...message,
            content: parsed.finalResult ?? message.content,
            rawContent: currentResponse,
          }));
          break;
        }

        if (parsed.toolCalls.length === 0) {
          const cleaned = this.cleanAssistantContent(currentResponse);
          if (cleaned && cleaned !== currentResponse) {
            this.updateLastMessage((message) => ({
              ...message,
              content: cleaned,
              rawContent: currentResponse,
            }));
          }
          break;
        }

        this.removeLastMessage();

        const toolResultMessages: string[] = [];

        for (const toolCall of parsed.toolCalls) {
          this.checkCancelled();

          let parameters = toolCall.parameters;
          if (this.hookDispatcher) {
            parameters = await this.hookDispatcher.dispatchBeforeToolCall(toolCall.name, parameters);
          }

          this.pushMessage({
            role: "tool_call",
            content: JSON.stringify(parameters, null, 2),
            toolName: toolCall.name,
            timestamp: new Date(),
          });

          try {
            const toolResult = await this.raceWithAbort(
              this.toolRegistry.executeTool(
                toolCall.name,
                parameters,
                toolContext,
              ),
            );

            if (this.hookDispatcher) {
              await this.hookDispatcher.dispatchAfterToolCall(toolCall.name, parameters, toolResult);
            }

            const resultPreview = toolResult.output.length > 500
              ? toolResult.output.slice(0, 500) + "..."
              : toolResult.output;

            this.pushMessage({
              role: "tool_result",
              content: resultPreview,
              toolName: toolCall.name,
              toolSuccess: toolResult.success,
              timestamp: new Date(),
            });

            toolResultMessages.push(
              formatToolResultForConversation(toolCall.name, toolResult),
            );
          } catch (toolError) {
            if (toolError instanceof CancelledError) throw toolError;

            const toolErrorMessage = toolError instanceof Error
              ? toolError.message
              : String(toolError);

            this.pushMessage({
              role: "tool_result",
              content: toolErrorMessage,
              toolName: toolCall.name,
              toolSuccess: false,
              timestamp: new Date(),
            });

            toolResultMessages.push(
              formatToolResultForConversation(toolCall.name, {
                success: false,
                output: "",
                error: toolErrorMessage,
              }),
            );
          }
        }

        const combinedResults = toolResultMessages.join("\n\n");

        try {
          currentResponse = await this.getResponse(combinedResults);
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
