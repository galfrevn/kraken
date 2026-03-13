import { LanguageModelClient } from "@core/language/client.ts";
import { ConversationHistory } from "@core/language/conversation.ts";
import { ToolRegistry } from "@core/tools/registry.ts";
import { buildSystemPrompt, type PromptOptions } from "@core/agent/prompt.ts";
import { toolsToNativeFormat } from "@core/tools/schema.ts";
import type { ToolExecutionContext } from "@core/tools/schema.ts";
import type { CompletionResult, ToolCallEntry, TokenUsageSummary } from "@core/language/schema.ts";
import type { HookDispatcher } from "@core/plugins/hooks.ts";
import type { PluginContext } from "@kraken/sdk";
import type { PendingQuestions } from "@core/tools/question.ts";
import type { ConfirmationDecision, PendingConfirmation } from "@core/tools/confirmation.ts";

const MAX_ITERATIONS_PER_MESSAGE = 40;
const CONTINUE_PROMPT = "Continue from where you left off. Complete any remaining steps without repeating what was already done.";

export type ChatMessageRole = "user" | "assistant" | "tool_call" | "tool_result" | "error" | "status";

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

export interface PlanStep {
  id: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  status: "draft" | "approved" | "executing" | "completed" | "failed";
  feedback: string[];
}

export type PlanListener = (plan: Plan | null) => void;

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

export interface SerializedPendingQuestions {
  id: string;
  items: import("@core/tools/question.ts").QuestionItem[];
}

export interface SerializedPendingConfirmation {
  id: string;
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface SerializedPlan {
  goal: string;
  steps: PlanStep[];
  status: Plan["status"];
  feedback: string[];
}

export interface SerializedChatEngine {
  messages: SerializedChatMessage[];
  conversationMessages: SerializedConversationMessage[];
  pendingQuestions?: SerializedPendingQuestions;
  pendingConfirmation?: SerializedPendingConfirmation;
  plan?: SerializedPlan;
  planMode?: boolean;
}

export type ChatEventListener = (messages: ChatMessage[]) => void;

function parsePlanFromContent(content: string): { goal: string; steps: string[] } | null {
  const planMatch = content.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) return null;
  const planContent = planMatch[1]!;
  const goalMatch = planContent.match(/<goal>([\s\S]*?)<\/goal>/);
  const steps = [...planContent.matchAll(/<step>([\s\S]*?)<\/step>/g)].map((m) => m[1]!.trim());
  if (steps.length === 0) return null;
  return {
    goal: goalMatch ? goalMatch[1]!.trim() : "",
    steps,
  };
}

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
  private pendingPlanFeedback: string | null = null;
  private hookDispatcher?: HookDispatcher;
  private pluginContext?: PluginContext;
  private planMode: boolean = false;
  private currentPlan: Plan | null = null;
  private planListeners: Set<PlanListener> = new Set();
  private pendingQuestions: PendingQuestions | null = null;
  private questionListeners: Set<(q: PendingQuestions | null) => void> = new Set();
  private pendingConfirmation: PendingConfirmation | null = null;
  private confirmationListeners: Set<(c: PendingConfirmation | null) => void> = new Set();
  private promptOptions: PromptOptions;
  private tokenUsage: TokenUsageSummary = { totalPromptTokens: 0, totalCompletionTokens: 0, requestCount: 0 };
  private debugLog: DebugLogEntry[] = [];

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
    this.conversation = new ConversationHistory(systemPrompt);

    this.languageModelClient.setNativeTools(toolsToNativeFormat(this.toolRegistry.listTools()));
  }

  private log(level: DebugLogEntry["level"], source: string, message: string): void {
    this.debugLog.push({ timestamp: new Date(), level, source, message });
    if (this.debugLog.length > 500) {
      this.debugLog = this.debugLog.slice(-400);
    }
  }

  getDebugLog(): readonly DebugLogEntry[] {
    return this.debugLog;
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

  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
    this.rebuildSystemPrompt();
  }

  private rebuildSystemPrompt(): void {
    const updatedOptions: PromptOptions = { ...this.promptOptions, planMode: this.planMode };
    const systemPrompt = buildSystemPrompt(this.toolRegistry.listTools(), updatedOptions);
    this.conversation.setSystemPrompt(systemPrompt);
  }

  isPlanMode(): boolean {
    return this.planMode;
  }

  getPlan(): Plan | null {
    return this.currentPlan;
  }

  addPlanListener(listener: PlanListener): void {
    this.planListeners.add(listener);
  }

  removePlanListener(listener: PlanListener): void {
    this.planListeners.delete(listener);
  }

  getPendingQuestions(): PendingQuestions | null {
    return this.pendingQuestions;
  }

  addQuestionListener(listener: (q: PendingQuestions | null) => void): void {
    this.questionListeners.add(listener);
  }

  removeQuestionListener(listener: (q: PendingQuestions | null) => void): void {
    this.questionListeners.delete(listener);
  }

  private notifyQuestionListeners(): void {
    for (const listener of this.questionListeners) {
      listener(this.pendingQuestions);
    }
  }

  handleQuestionsAsked(pending: PendingQuestions): void {
    const originalResolve = pending.resolve;
    this.pendingQuestions = {
      ...pending,
      resolve: (answers) => {
        this.pendingQuestions = null;
        this.notifyQuestionListeners();
        originalResolve(answers);
      },
    };
    this.notifyQuestionListeners();
  }

  resolveQuestions(answers: import("@core/tools/question.ts").QuestionAnswer[]): void {
    if (!this.pendingQuestions) return;
    this.pendingQuestions.resolve(answers);
  }

  getPendingConfirmation(): PendingConfirmation | null {
    return this.pendingConfirmation;
  }

  addConfirmationListener(listener: (c: PendingConfirmation | null) => void): void {
    this.confirmationListeners.add(listener);
  }

  removeConfirmationListener(listener: (c: PendingConfirmation | null) => void): void {
    this.confirmationListeners.delete(listener);
  }

  private notifyConfirmationListeners(): void {
    for (const listener of this.confirmationListeners) {
      listener(this.pendingConfirmation);
    }
  }

  resolveConfirmation(decision: ConfirmationDecision): void {
    if (!this.pendingConfirmation) return;
    this.pendingConfirmation.resolve(decision);
  }

  private requestConfirmation(toolName: string, parameters: Record<string, unknown>): Promise<ConfirmationDecision> {
    return new Promise<ConfirmationDecision>((resolve, reject) => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      const onAbort = () => {
        this.pendingConfirmation = null;
        this.notifyConfirmationListeners();
        reject(new CancelledError());
      };

      if (this.abortController?.signal.aborted) {
        reject(new CancelledError());
        return;
      }

      this.abortController?.signal.addEventListener("abort", onAbort, { once: true });

      this.pendingConfirmation = {
        id,
        toolName,
        parameters,
        resolve: (decision) => {
          this.abortController?.signal.removeEventListener("abort", onAbort);
          this.pendingConfirmation = null;
          this.notifyConfirmationListeners();
          resolve(decision);
        },
      };
      this.notifyConfirmationListeners();
    });
  }

  private async executeToolWithConfirmation(
    toolCall: ToolCallEntry,
    parameters: Record<string, unknown>,
    toolContext: ToolExecutionContext,
  ): Promise<{ toolCall: ToolCallEntry; parameters: Record<string, unknown>; toolResult: import("@core/tools/schema.ts").ToolResult | null; error: string | null }> {
    const tool = this.toolRegistry.getTool(toolCall.function.name);
    if (tool?.definition.requiresConfirmation) {
      const decision = await this.requestConfirmation(toolCall.function.name, parameters);
      if (!decision.approved) {
        const reason = decision.reason ? `: ${decision.reason}` : "";
        return {
          toolCall,
          parameters,
          toolResult: { success: false, output: "", error: `rejected by user${reason}` },
          error: null,
        };
      }
    }

    try {
      const toolResult = await this.raceWithAbort(
        this.toolRegistry.executeTool(toolCall.function.name, parameters, toolContext),
      );

      if (this.hookDispatcher) {
        await this.hookDispatcher.dispatchAfterToolCall(toolCall.function.name, parameters, toolResult);
      }

      return { toolCall, parameters, toolResult, error: null };
    } catch (toolError) {
      if (toolError instanceof CancelledError) throw toolError;
      const toolErrorMessage = toolError instanceof Error ? toolError.message : String(toolError);
      return { toolCall, parameters, toolResult: null, error: toolErrorMessage };
    }
  }

  private notifyPlanListeners(): void {
    for (const listener of this.planListeners) {
      listener(this.currentPlan);
    }
  }

  addPlanFeedback(feedback: string): void {
    if (!this.currentPlan || this.currentPlan.status !== "draft") return;
    this.currentPlan.feedback.push(feedback);
    this.notifyPlanListeners();
    // Ensure plan mode is on for feedback (it's inherently a plan operation)
    this.planMode = true;
    // Show only the user's feedback in chat, but send the full prompt to the LLM
    this.pendingPlanFeedback = feedback;
    this.enqueueMessage(feedback);
  }

  approvePlan(): void {
    if (!this.currentPlan || this.currentPlan.status !== "draft") return;
    this.currentPlan.status = "approved";
    this.notifyPlanListeners();
    this.processMessageWithPlanExecution();
  }

  private async processMessageWithPlanExecution(): Promise<void> {
    const plan = this.currentPlan;
    if (!plan) return;
    if (this.processing) return;

    this.processing = true;
    this.abortController = new AbortController();
    this.emitImmediate();

    plan.status = "executing";
    this.notifyPlanListeners();

    try {
      for (const step of plan.steps) {
        if (this.abortController?.signal.aborted) {
          step.status = "failed";
          this.notifyPlanListeners();
          continue;
        }

        step.status = "in_progress";
        this.notifyPlanListeners();

        const stepPrompt = `Execute step ${step.id} of the approved plan: ${step.description}\n\nOnly do this specific step. When done, confirm what was accomplished.`;
        const stepLabel = `Step ${step.id}/${plan.steps.length}: ${step.description}`;

        try {
          await this.executeSingleStep(stepPrompt, stepLabel);
          step.status = "completed";
        } catch (err) {
          if (err instanceof CancelledError) {
            step.status = "failed";
            this.notifyPlanListeners();
            break;
          }
          step.status = "failed";
        }

        this.notifyPlanListeners();
      }

      plan.status = plan.steps.some((s) => s.status === "failed") ? "failed" : "completed";
      this.notifyPlanListeners();
    } finally {
      this.processing = false;
      this.abortController = null;
      this.emitImmediate();

      if (this.messageQueue.length > 0) {
        queueMicrotask(() => this.processNextInQueue());
      }
    }
  }

  private async executeSingleStep(prompt: string, stepLabel?: string): Promise<void> {
    // This is a sub-routine of executePlan that reuses the agent loop
    // without setting this.processing (which is managed by the outer processMessage call)

    if (stepLabel) {
      this.pushMessage({
        role: "status",
        content: stepLabel,
        timestamp: new Date(),
      });
    }

    const toolContext: ToolExecutionContext = {
      workingDirectory: this.workingDirectory,
    };

    let completionResult = await this.getResponse(prompt);
    let iterations = 0;

    while (iterations < MAX_ITERATIONS_PER_MESSAGE) {
      this.checkCancelled();
      iterations += 1;

      if (completionResult.finishReason !== "tool_calls" || completionResult.toolCalls.length === 0) {
        break;
      }

      const lastMsg = this.messages[this.messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant" && !lastMsg.content.trim()) {
        this.removeLastMessage();
      }

      const preparedCalls = await Promise.all(
        completionResult.toolCalls.map(async (toolCall) => {
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

          return { toolCall, parameters };
        }),
      );

      this.checkCancelled();

      const results = await Promise.all(
        preparedCalls.map(({ toolCall, parameters }) =>
          this.executeToolWithConfirmation(toolCall, parameters, toolContext),
        ),
      );

      for (const { toolCall, toolResult, error } of results) {
        if (toolResult) {
          const resultText = toolResult.success
            ? toolResult.output
            : (toolResult.error ?? toolResult.output);
          const resultPreview = resultText.length > 3000
            ? resultText.slice(0, 3000) + "..."
            : resultText;

          this.pushMessage({
            role: "tool_result",
            content: resultPreview,
            rawContent: resultText,
            toolName: toolCall.function.name,
            toolSuccess: toolResult.success,
            timestamp: new Date(),
          });

          this.conversation.addToolResultMessage(
            toolCall.id,
            toolCall.function.name,
            resultText,
          );
        } else {
          this.pushMessage({
            role: "tool_result",
            content: error!,
            rawContent: error!,
            toolName: toolCall.function.name,
            toolSuccess: false,
            timestamp: new Date(),
          });

          this.conversation.addToolResultMessage(toolCall.id, toolCall.function.name, error!);
        }
      }

      try {
        completionResult = await this.getResponseContinuation();
      } catch (followUpError) {
        if (followUpError instanceof CancelledError) throw followUpError;
        break;
      }
    }
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
      pendingQuestions: this.pendingQuestions
        ? { id: this.pendingQuestions.id, items: this.pendingQuestions.items }
        : undefined,
      pendingConfirmation: this.pendingConfirmation
        ? { id: this.pendingConfirmation.id, toolName: this.pendingConfirmation.toolName, parameters: this.pendingConfirmation.parameters }
        : undefined,
      plan: this.currentPlan
        ? { goal: this.currentPlan.goal, steps: this.currentPlan.steps, status: this.currentPlan.status, feedback: this.currentPlan.feedback }
        : undefined,
      planMode: this.planMode || undefined,
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

    if (state.pendingQuestions) {
      const sq = state.pendingQuestions;
      this.pendingQuestions = {
        id: sq.id,
        items: sq.items,
        resolve: (answers) => {
          const lines = ["# Questions", ""];
          for (const a of answers) {
            lines.push(a.question);
            lines.push(a.answer);
            lines.push("");
          }
          this.pendingQuestions = null;
          this.notifyQuestionListeners();
          this.pushMessage({
            role: "tool_result",
            content: lines.join("\n"),
            toolName: "ask_question",
            toolSuccess: true,
            timestamp: new Date(),
          });
          this.conversation.addUserMessage(lines.join("\n"));
        },
      };
      this.notifyQuestionListeners();
    }

    if (state.pendingConfirmation) {
      const sc = state.pendingConfirmation;
      this.pendingConfirmation = {
        id: sc.id,
        toolName: sc.toolName,
        parameters: sc.parameters,
        resolve: (decision) => {
          const resultText = decision.approved
            ? "approved by user"
            : `rejected by user${decision.reason ? `: ${decision.reason}` : ""}`;
          this.pendingConfirmation = null;
          this.notifyConfirmationListeners();
          this.pushMessage({
            role: "tool_result",
            content: resultText,
            toolName: sc.toolName,
            toolSuccess: decision.approved,
            timestamp: new Date(),
          });
          this.conversation.addUserMessage(resultText);
        },
      };
      this.notifyConfirmationListeners();
    }

    if (state.plan) {
      this.currentPlan = {
        goal: state.plan.goal,
        steps: state.plan.steps.map((s) => ({ ...s })),
        status: state.plan.status,
        feedback: state.plan.feedback ?? [],
      };
      this.notifyPlanListeners();
    }

    if (state.planMode) {
      this.planMode = true;
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

      this.conversation.compactIfNeeded();

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

    if (this.hookDispatcher && this.pluginContext) {
      await this.hookDispatcher.dispatchConversationStart(this.pluginContext).catch((e: unknown) => {
        this.log("warn", "hook", `conversationStart failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    try {
      const isPlanGeneration = this.planMode;

      const isFeedback = this.pendingPlanFeedback !== null;
      let llmInput = userInput;
      if (isFeedback) {
        llmInput = `Revise the plan based on this feedback: ${this.pendingPlanFeedback}\n\nYou may use read-only tools to investigate further if needed. If the feedback raises new ambiguities or choices, use ask_question to clarify with the user before finalizing. Then output the updated plan inside <plan> tags with <goal> and <step> tags.`;
        this.pendingPlanFeedback = null;
      }
      if (attachments && attachments.length > 0) {
        const attachmentLines = attachments.map((a) =>
          a.isImage
            ? `[Attached image: ${a.path}] (use view_image tool to analyze)`
            : `[Attached file: ${a.path}] (use read_file tool to read)`,
        );
        llmInput = llmInput + "\n\n" + attachmentLines.join("\n");
      }

      let completionResult = await this.getResponse(llmInput);

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

        // Parse parameters and push tool_call messages first
        const preparedCalls = await Promise.all(
          completionResult.toolCalls.map(async (toolCall) => {
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

            return { toolCall, parameters };
          }),
        );

        this.checkCancelled();

        // Execute all tools in parallel (with confirmation checks)
        const results = await Promise.all(
          preparedCalls.map(({ toolCall, parameters }) =>
            this.executeToolWithConfirmation(toolCall, parameters, toolContext),
          ),
        );

        // Push results in order and add to conversation history
        for (const { toolCall, toolResult, error } of results) {
          if (toolResult) {
            const resultText = toolResult.success
              ? toolResult.output
              : (toolResult.error ?? toolResult.output);
            const resultPreview = resultText.length > 3000
              ? resultText.slice(0, 3000) + "..."
              : resultText;

            this.pushMessage({
              role: "tool_result",
              content: resultPreview,
              rawContent: resultText,
              toolName: toolCall.function.name,
              toolSuccess: toolResult.success,
              timestamp: new Date(),
            });

            this.conversation.addToolResultMessage(
              toolCall.id,
              toolCall.function.name,
              resultText,
            );

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

            this.conversation.addToolResultMessage(
              toolCall.id,
              toolCall.function.name,
              error!,
            );
          }
        }

        try {
          completionResult = await this.getResponseContinuation();
        } catch (followUpError) {
          if (followUpError instanceof CancelledError) throw followUpError;
          const errorDetail = followUpError instanceof Error ? followUpError.message : String(followUpError);
          this.pushMessage({
            role: "error",
            content: `follow-up response failed: ${errorDetail}`,
            timestamp: new Date(),
          });
          this.log("error", "llm", `follow-up response failed: ${errorDetail}`);
          break;
        }
      }

      if (isPlanGeneration) {
        // Scan all assistant messages for a <plan> block (the last one wins)
        for (let i = this.messages.length - 1; i >= 0; i--) {
          const msg = this.messages[i];
          if (msg && msg.role === "assistant") {
            const raw = msg.rawContent ?? msg.content;
            const parsed = parsePlanFromContent(raw);
            if (parsed) {
              this.currentPlan = {
                goal: parsed.goal,
                steps: parsed.steps.map((desc, idx) => ({
                  id: idx + 1,
                  description: desc,
                  status: "pending",
                })),
                status: "draft",
                feedback: [],
              };
              this.notifyPlanListeners();
              // Auto-approve: execute the plan immediately after generation
              queueMicrotask(() => this.approvePlan());
              break;
            }
          }
        }
      }

      if (iterations >= MAX_ITERATIONS_PER_MESSAGE && !isPlanGeneration) {
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
        this.log("error", "engine", errorMessage);
      }
    } finally {
      if (this.hookDispatcher && this.pluginContext) {
        await this.hookDispatcher.dispatchConversationEnd(this.pluginContext).catch((e: unknown) => {
          this.log("warn", "hook", `conversationEnd failed: ${e instanceof Error ? e.message : String(e)}`);
        });
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
      this.conversation.compactIfNeeded();
      const messages = this.conversation.getMessagesWithSystemPrompt();
      const completionResult = await this.languageModelClient.complete(messages);
      this.trackTokenUsage(completionResult);

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
}
