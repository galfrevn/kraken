import { LanguageModelClient } from "@/language/client.ts";
import { ConversationHistory } from "@/language/conversation.ts";
import { TaskQueueManager } from "@/queue/manager.ts";
import { ToolRegistry } from "@/tools/registry.ts";
import { buildSystemPrompt, buildTaskPrompt } from "@/agent/prompt.ts";
import { toolsToNativeFormat } from "@/tools/schema.ts";
import type { Task } from "@/queue/schema.ts";
import type { ToolExecutionContext } from "@/tools/schema.ts";
import type { AgentDatabase } from "@/storage/database.ts";
import type { HookDispatcher } from "@/plugins/hooks.ts";
import type { ToolCallEntry } from "@/language/schema.ts";

const DEFAULT_MAX_ITERATIONS = 40;

export interface AgentLoopConfiguration {
  maxIterations?: number;
  workingDirectory: string;
}

export interface AgentLoopResult {
  taskId: string;
  success: boolean;
  output: string;
  iterations: number;
  totalToolCalls: number;
}

export class AgentExecutionLoop {
  private languageModelClient: LanguageModelClient;
  private taskQueueManager: TaskQueueManager;
  private toolRegistry: ToolRegistry;
  private database: AgentDatabase;
  private maxIterations: number;
  private workingDirectory: string;
  private hookDispatcher?: HookDispatcher;

  constructor(
    languageModelClient: LanguageModelClient,
    taskQueueManager: TaskQueueManager,
    toolRegistry: ToolRegistry,
    database: AgentDatabase,
    configuration: AgentLoopConfiguration,
  ) {
    this.languageModelClient = languageModelClient;
    this.taskQueueManager = taskQueueManager;
    this.toolRegistry = toolRegistry;
    this.database = database;
    this.maxIterations = configuration.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.workingDirectory = configuration.workingDirectory;
  }

  setHookDispatcher(dispatcher: HookDispatcher): void {
    this.hookDispatcher = dispatcher;
  }

  async executeTask(taskId: string): Promise<AgentLoopResult> {
    const task = this.taskQueueManager.startTask(taskId);
    this.database.addTaskLog(task.id, "info", `executing task: ${task.name}`);

    const systemPrompt = buildSystemPrompt(this.toolRegistry.listTools());
    const conversation = new ConversationHistory(systemPrompt);
    const taskPrompt = buildTaskPrompt(task);

    this.languageModelClient.setNativeTools(toolsToNativeFormat(this.toolRegistry.listTools()));

    const toolExecutionContext: ToolExecutionContext = {
      workingDirectory: this.workingDirectory,
    };

    let iterations = 0;
    let totalToolCalls = 0;

    try {
      let completionResult = await this.languageModelClient.completeConversation(
        conversation,
        taskPrompt,
      );

      while (iterations < this.maxIterations) {
        iterations += 1;

        if (completionResult.finishReason !== "tool_calls" || completionResult.toolCalls.length === 0) {
          const output = completionResult.content;
          this.taskQueueManager.completeTask(task.id, output);
          return {
            taskId: task.id,
            success: true,
            output,
            iterations,
            totalToolCalls,
          };
        }

        await this.executeToolCalls(
          completionResult.toolCalls,
          conversation,
          toolExecutionContext,
          task,
        );

        totalToolCalls += completionResult.toolCalls.length;

        const messages = conversation.getMessagesWithSystemPrompt();
        completionResult = await this.languageModelClient.complete(messages);

        if (completionResult.toolCalls.length > 0) {
          conversation.addAssistantToolCallMessage(completionResult.content, completionResult.toolCalls);
        } else {
          conversation.addAssistantMessage(completionResult.content);
        }
      }

      const timeoutMessage = `task reached maximum iterations (${this.maxIterations})`;
      this.taskQueueManager.failTask(task.id, timeoutMessage);
      return {
        taskId: task.id,
        success: false,
        output: timeoutMessage,
        iterations,
        totalToolCalls,
      };
    } catch (executionError) {
      const errorMessage =
        executionError instanceof Error ? executionError.message : String(executionError);
      this.taskQueueManager.failTask(task.id, errorMessage);
      this.database.addTaskLog(task.id, "error", `execution failed: ${errorMessage}`);
      return {
        taskId: task.id,
        success: false,
        output: errorMessage,
        iterations,
        totalToolCalls,
      };
    }
  }

  async executeNextPendingTask(): Promise<AgentLoopResult | undefined> {
    const nextTask = this.taskQueueManager.getNextPendingTask();
    if (!nextTask) return undefined;
    return this.executeTask(nextTask.id);
  }

  private async executeToolCalls(
    toolCalls: ToolCallEntry[],
    conversation: ConversationHistory,
    context: ToolExecutionContext,
    task: Task,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      let parameters: Record<string, unknown>;
      try {
        parameters = JSON.parse(toolCall.function.arguments);
      } catch {
        parameters = {};
      }

      if (this.hookDispatcher) {
        parameters = await this.hookDispatcher.dispatchBeforeToolCall(toolCall.function.name, parameters);
      }

      this.database.addTaskLog(task.id, "info", `calling tool: ${toolCall.function.name}`, {
        parameters: JSON.stringify(parameters),
      });

      const toolResult = await this.toolRegistry.executeTool(toolCall.function.name, parameters, context);

      if (this.hookDispatcher) {
        await this.hookDispatcher.dispatchAfterToolCall(toolCall.function.name, parameters, toolResult);
      }

      this.database.addTaskLog(
        task.id,
        toolResult.success ? "info" : "error",
        `tool ${toolCall.function.name}: ${toolResult.success ? "success" : toolResult.error}`,
      );

      conversation.addToolResultMessage(
        toolCall.id,
        toolCall.function.name,
        toolResult.success ? toolResult.output : (toolResult.error ?? toolResult.output),
      );
    }
  }
}
