import { LanguageModelClient } from "@/language/client.ts";
import { ConversationHistory } from "@/language/conversation.ts";
import { TaskQueueManager } from "@/queue/manager.ts";
import { ToolRegistry } from "@/tools/registry.ts";
import { buildSystemPrompt, buildTaskPrompt } from "@/agent/prompt.ts";
import { parseAgentResponse, formatToolResultForConversation } from "@/agent/parser.ts";
import type { Task } from "@/queue/schema.ts";
import type { ToolExecutionContext } from "@/tools/schema.ts";
import type { AgentDatabase } from "@/storage/database.ts";
import type { HookDispatcher } from "@/plugins/hooks.ts";

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

    const toolExecutionContext: ToolExecutionContext = {
      workingDirectory: this.workingDirectory,
    };

    let iterations = 0;
    let totalToolCalls = 0;

    try {
      const completionResult = await this.languageModelClient.completeConversation(
        conversation,
        taskPrompt,
      );

      let currentResponse = completionResult.content;

      while (iterations < this.maxIterations) {
        iterations += 1;
        const parsed = parseAgentResponse(currentResponse);

        if (parsed.finalResult) {
          this.taskQueueManager.completeTask(task.id, parsed.finalResult);
          return {
            taskId: task.id,
            success: true,
            output: parsed.finalResult,
            iterations,
            totalToolCalls,
          };
        }

        if (parsed.toolCalls.length === 0) {
          this.taskQueueManager.completeTask(task.id, currentResponse);
          return {
            taskId: task.id,
            success: true,
            output: currentResponse,
            iterations,
            totalToolCalls,
          };
        }

        const toolResultMessages = await this.executeToolCalls(
          parsed.toolCalls,
          toolExecutionContext,
          task,
        );

        totalToolCalls += parsed.toolCalls.length;
        const combinedToolResults = toolResultMessages.join("\n\n");

        const nextCompletion = await this.languageModelClient.completeConversation(
          conversation,
          combinedToolResults,
        );

        currentResponse = nextCompletion.content;
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
    toolCalls: { name: string; parameters: Record<string, unknown> }[],
    context: ToolExecutionContext,
    task: Task,
  ): Promise<string[]> {
    const results: string[] = [];

    for (const toolCall of toolCalls) {
      let parameters = toolCall.parameters;

      if (this.hookDispatcher) {
        parameters = await this.hookDispatcher.dispatchBeforeToolCall(toolCall.name, parameters);
      }

      this.database.addTaskLog(task.id, "info", `calling tool: ${toolCall.name}`, {
        parameters: JSON.stringify(parameters),
      });

      const toolResult = await this.toolRegistry.executeTool(toolCall.name, parameters, context);

      if (this.hookDispatcher) {
        await this.hookDispatcher.dispatchAfterToolCall(toolCall.name, parameters, toolResult);
      }

      this.database.addTaskLog(
        task.id,
        toolResult.success ? "info" : "error",
        `tool ${toolCall.name}: ${toolResult.success ? "success" : toolResult.error}`,
      );

      results.push(formatToolResultForConversation(toolCall.name, toolResult));
    }

    return results;
  }
}
