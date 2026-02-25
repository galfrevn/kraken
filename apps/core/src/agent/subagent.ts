import { LanguageModelClient } from "@/language/client.ts";
import { ConversationHistory } from "@/language/conversation.ts";
import { ToolRegistry } from "@/tools/registry.ts";
import { buildSystemPrompt } from "@/agent/prompt.ts";
import { parseAgentResponse, formatToolResultForConversation } from "@/agent/parser.ts";
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
    const systemPrompt = buildSystemPrompt(this.toolRegistry.listTools());
    const conversation = new ConversationHistory(systemPrompt);

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
      const initialCompletion = await this.languageModelClient.completeConversation(
        conversation,
        taskPrompt,
        completionOptions,
      );

      let currentResponse = initialCompletion.content;

      while (iterations < maxIterations) {
        iterations += 1;
        const parsed = parseAgentResponse(currentResponse);

        if (parsed.finalResult) {
          return {
            success: true,
            output: parsed.finalResult,
            iterations,
            toolCalls: totalToolCalls,
          };
        }

        if (parsed.toolCalls.length === 0) {
          return {
            success: true,
            output: currentResponse,
            iterations,
            toolCalls: totalToolCalls,
          };
        }

        const toolResultMessages: string[] = [];

        for (const toolCall of parsed.toolCalls) {
          const toolResult = await this.toolRegistry.executeTool(
            toolCall.name,
            toolCall.parameters,
            toolExecutionContext,
          );

          toolResultMessages.push(formatToolResultForConversation(toolCall.name, toolResult));
        }

        totalToolCalls += parsed.toolCalls.length;
        const combinedResults = toolResultMessages.join("\n\n");

        const nextCompletion = await this.languageModelClient.completeConversation(
          conversation,
          combinedResults,
          completionOptions,
        );

        currentResponse = nextCompletion.content;
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
