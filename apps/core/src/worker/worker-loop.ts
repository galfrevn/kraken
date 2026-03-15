import type { DaemonWorkerClient, TaskDetails } from "@/worker/daemon-client.ts";
import type { ToolRegistry } from "@/tools/registry.ts";
import type { ToolExecutionContext } from "@/tools/schema.ts";
import { ConversationHistory } from "@/language/conversation.ts";
import { parseAgentResponse, formatToolResultForConversation } from "@/agent/parser.ts";
import { buildSystemPrompt } from "@/agent/prompt.ts";
import type { ConversationMessage } from "@/language/schema.ts";

/** Exit code constants for worker process results. */
export const WORKER_EXIT_CODE = {
  /** Task completed successfully. */
  SUCCESS: 0,
  /** Unhandled exception or crash during execution. */
  AGENT_ERROR: 1,
  /** Agent reached maximum iteration count without finishing. */
  MAX_ITERATIONS: 2,
  /** Invalid input (bad arguments, missing task, etc). */
  BAD_INPUT: 3,
} as const;

export interface WorkerArtifact {
  type: string;
  url: string;
  name: string;
}

export interface WorkerResult {
  exitCode: number;
  output: string;
  errorMessage: string;
  artifacts: WorkerArtifact[];
}

const MAX_ITERATIONS = 40;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";

export async function runWorkerLoop(
  daemonWorkerClient: DaemonWorkerClient,
  taskDetails: TaskDetails,
  toolRegistry: ToolRegistry,
  workingDirectory: string,
): Promise<WorkerResult> {
  const availableTools = toolRegistry.listTools();
  const systemPrompt = buildSystemPrompt(availableTools, {
    environmentContext: {
      workingDirectory,
      platform: process.platform,
      shell: process.env.SHELL ?? "bash",
      date: new Date().toISOString().slice(0, 10),
      modelName: DEFAULT_MODEL,
    },
  });

  const conversationHistory = new ConversationHistory(systemPrompt, { maxMessages: 20 });

  const initialUserMessage = buildInitialUserMessage(taskDetails);
  conversationHistory.addUserMessage(initialUserMessage);

  const toolExecutionContext: ToolExecutionContext = { workingDirectory };
  const collectedArtifacts: WorkerArtifact[] = [];

  await writeLogToDaemon(daemonWorkerClient, taskDetails.taskId, "info", `Starting task: ${taskDetails.name}`);

  for (let iterationIndex = 0; iterationIndex < MAX_ITERATIONS; iterationIndex++) {
    await reportProgressToDaemon(
      daemonWorkerClient,
      taskDetails.taskId,
      `Iteration ${iterationIndex + 1}/${MAX_ITERATIONS}`,
      (iterationIndex / MAX_ITERATIONS) * 100,
    );

    // Call LLM via daemon proxy
    const completionResponse = await callLlmViaDaemon(
      daemonWorkerClient,
      conversationHistory,
    );

    const assistantResponseText = completionResponse;

    // Parse tool calls from response
    const parsedResponse = parseAgentResponse(assistantResponseText);

    // If no tool calls, the agent is done
    if (parsedResponse.toolCalls.length === 0) {
      const finalOutput = parsedResponse.finalResult ?? parsedResponse.rawText;

      await writeLogToDaemon(
        daemonWorkerClient,
        taskDetails.taskId,
        "info",
        `Task completed after ${iterationIndex + 1} iterations`,
      );

      return {
        exitCode: WORKER_EXIT_CODE.SUCCESS,
        output: finalOutput,
        errorMessage: "",
        artifacts: collectedArtifacts,
      };
    }

    // Add assistant message with tool calls to history
    conversationHistory.addAssistantMessage(assistantResponseText);

    // Execute each tool call
    for (const toolCall of parsedResponse.toolCalls) {
      await writeLogToDaemon(
        daemonWorkerClient,
        taskDetails.taskId,
        "info",
        `Executing tool: ${toolCall.name}`,
      );

      const toolResult = await toolRegistry.executeTool(
        toolCall.name,
        toolCall.parameters,
        toolExecutionContext,
      );

      const formattedToolResult = formatToolResultForConversation(toolCall.name, toolResult);
      conversationHistory.addUserMessage(formattedToolResult);

      if (!toolResult.success) {
        await writeLogToDaemon(
          daemonWorkerClient,
          taskDetails.taskId,
          "warn",
          `Tool ${toolCall.name} failed: ${toolResult.error ?? toolResult.output}`,
        );
      }
    }

    // Compact conversation if needed to stay within limits
    conversationHistory.compactIfNeeded();
  }

  // Reached max iterations without the agent finishing
  await writeLogToDaemon(
    daemonWorkerClient,
    taskDetails.taskId,
    "warn",
    `Task reached maximum iterations (${MAX_ITERATIONS}) without completion`,
  );

  return {
    exitCode: WORKER_EXIT_CODE.MAX_ITERATIONS,
    output: "",
    errorMessage: `Agent reached maximum iteration limit (${MAX_ITERATIONS}) without completing the task`,
    artifacts: collectedArtifacts,
  };
}

function buildInitialUserMessage(taskDetails: TaskDetails): string {
  let message = `# Task: ${taskDetails.name}\n\n${taskDetails.description}`;

  if (taskDetails.retryContext) {
    message += `\n\n## Retry Context\n\nThis is attempt ${taskDetails.attempt}. Previous attempt context:\n${taskDetails.retryContext}`;
  }

  message += `\n\nExecute this task completely. Use the available tools as needed. When finished, provide a clear summary in a <result> block.`;

  return message;
}

async function callLlmViaDaemon(
  daemonWorkerClient: DaemonWorkerClient,
  conversationHistory: ConversationHistory,
): Promise<string> {
  const allMessages = conversationHistory.getMessagesWithSystemPrompt();

  const gatewayMessages = allMessages
    .filter((message: ConversationMessage) => message.role !== "system")
    .map((message: ConversationMessage) => ({
      role: message.role,
      content: message.content,
      toolCalls: [],
      toolCallId: "",
    }));

  const systemMessage = allMessages.find(
    (message: ConversationMessage) => message.role === "system",
  );

  const completeResponse = await daemonWorkerClient.complete({
    model: DEFAULT_MODEL,
    messages: gatewayMessages,
    systemPrompt: systemMessage?.content,
    tools: [],
    temperature: 0.3,
    maxTokens: 16384,
  });

  return completeResponse.message?.content ?? "";
}

async function reportProgressToDaemon(
  daemonWorkerClient: DaemonWorkerClient,
  taskId: string,
  activity: string,
  progressPercent: number,
): Promise<void> {
  try {
    await daemonWorkerClient.reportProgress({
      taskId,
      activity,
      progressPct: progressPercent,
    });
  } catch (progressReportError) {
    // Non-fatal: log but don't crash the worker
    console.error(
      `Failed to report progress: ${progressReportError instanceof Error ? progressReportError.message : String(progressReportError)}`,
    );
  }
}

async function writeLogToDaemon(
  daemonWorkerClient: DaemonWorkerClient,
  taskId: string,
  level: string,
  message: string,
): Promise<void> {
  try {
    await daemonWorkerClient.writeLog({ taskId, level, message });
  } catch (logWriteError) {
    // Non-fatal: log to stderr but don't crash the worker
    console.error(
      `Failed to write log: ${logWriteError instanceof Error ? logWriteError.message : String(logWriteError)}`,
    );
  }
}
