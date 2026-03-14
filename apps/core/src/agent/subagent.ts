import { LanguageModelClient } from "@/language/client.ts";
import { ConversationHistory } from "@/language/conversation.ts";
import { ToolRegistry } from "@/tools/registry.ts";
import { buildSystemPrompt, type EnvironmentContext } from "@/agent/prompt.ts";
import { toolsToNativeFormat } from "@/tools/schema.ts";
import type { ToolExecutionContext } from "@/tools/schema.ts";

const DEFAULT_SUBAGENT_MAX_ITERATIONS = 25;

export interface SubagentConfiguration {
  task: string;
  model?: string;
  context?: string;
  maxIterations?: number;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  iterations: number;
  toolCalls: number;
}

export class SubagentRunner {
  private languageModelClient: LanguageModelClient;
  private toolRegistry: ToolRegistry;
  private workingDirectory: string;

  constructor(
    languageModelClient: LanguageModelClient,
    toolRegistry: ToolRegistry,
    workingDirectory: string,
  ) {
    this.languageModelClient = languageModelClient;
    this.toolRegistry = toolRegistry;
    this.workingDirectory = workingDirectory;
  }

  async execute(configuration: SubagentConfiguration): Promise<SubagentResult> {
    const maxIterations = configuration.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;
    const environmentContext: EnvironmentContext = {
      workingDirectory: this.workingDirectory,
      platform: process.platform,
      shell: process.env.SHELL || (process.platform === "win32" ? "powershell" : "bash"),
      date: new Date().toISOString().split("T")[0]!,
      modelName: configuration.model ?? this.languageModelClient.getModel(),
    };
    const systemPrompt = buildSystemPrompt(this.toolRegistry.listTools(), { environmentContext });
    const conversation = new ConversationHistory(systemPrompt);

    this.languageModelClient.setNativeTools(toolsToNativeFormat(this.toolRegistry.listTools()));

    const toolExecutionContext: ToolExecutionContext = {
      workingDirectory: this.workingDirectory,
    };

    const taskPrompt = configuration.context
      ? `${configuration.task}\n\n## Context\n\n${configuration.context}`
      : configuration.task;

    const completionOptions = configuration.model ? { model: configuration.model } : undefined;

    let iterations = 0;
    let totalToolCalls = 0;

    try {
      let completionResult = await this.languageModelClient.completeConversation(
        conversation,
        taskPrompt,
        completionOptions,
      );

      while (iterations < maxIterations) {
        iterations += 1;

        if (
          completionResult.finishReason !== "tool_calls" ||
          completionResult.toolCalls.length === 0
        ) {
          return {
            success: true,
            output: completionResult.content,
            iterations,
            toolCalls: totalToolCalls,
          };
        }

        for (const toolCall of completionResult.toolCalls) {
          let parameters: Record<string, unknown>;
          try {
            parameters = JSON.parse(toolCall.function.arguments);
          } catch {
            parameters = {};
          }

          const toolResult = await this.toolRegistry.executeTool(
            toolCall.function.name,
            parameters,
            toolExecutionContext,
          );

          conversation.addToolResultMessage(
            toolCall.id,
            toolCall.function.name,
            toolResult.success ? toolResult.output : (toolResult.error ?? toolResult.output),
          );
        }

        totalToolCalls += completionResult.toolCalls.length;

        const messages = conversation.getMessagesWithSystemPrompt();
        completionResult = await this.languageModelClient.complete(messages, completionOptions);

        if (completionResult.toolCalls.length > 0) {
          conversation.addAssistantToolCallMessage(
            completionResult.content,
            completionResult.toolCalls,
          );
        } else {
          conversation.addAssistantMessage(completionResult.content);
        }
      }

      return {
        success: false,
        output: `subagent reached maximum iterations (${maxIterations})`,
        iterations,
        toolCalls: totalToolCalls,
      };
    } catch (executionError) {
      const errorMessage =
        executionError instanceof Error ? executionError.message : String(executionError);

      return {
        success: false,
        output: errorMessage,
        iterations,
        toolCalls: totalToolCalls,
      };
    }
  }
}
