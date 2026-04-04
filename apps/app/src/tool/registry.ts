import { tool as vercelTool } from "ai";
import type { ToolDefinition } from "@/tool/tool.ts";
import type { ToolResult } from "@/tool/tool.ts";
import { logToolCall } from "@/audit/index.ts";
import { getLspManager, formatDiagnostics } from "@/lsp/manager.ts";

const registeredTools = new Map<string, ToolDefinition>();
const sessionToolCallCounts = new Map<string, number>();

const DEFAULT_TOOL_CALLS_PER_SESSION = 200;

export function registerTool(toolDefinition: ToolDefinition): void {
  registeredTools.set(toolDefinition.id, toolDefinition);
}

export function clearSessionToolCallCount(sessionId: string): void {
  sessionToolCallCounts.delete(sessionId);
}

export function resolveToolsForAiSdk(context: {
  sessionId: string;
  messageId: string;
  workingDirectory: string;
  abortSignal: AbortSignal;
  channelType?: string;
  channelChatId?: string;
}) {
  const resolvedTools: Record<string, ReturnType<typeof vercelTool>> = {};

  for (const [toolId, toolDefinition] of registeredTools) {
    resolvedTools[toolId] = vercelTool({
      description: toolDefinition.description,
      parameters: toolDefinition.parameters,
      execute: async (args: unknown) => {
        const currentCount = sessionToolCallCounts.get(context.sessionId) ?? 0;
        if (currentCount >= DEFAULT_TOOL_CALLS_PER_SESSION) {
          return {
            content: `Rate limit reached: ${DEFAULT_TOOL_CALLS_PER_SESSION} tool calls per session. Please wrap up your current work and provide a summary.`,
          };
        }
        sessionToolCallCounts.set(context.sessionId, currentCount + 1);

        const startTime = performance.now();
        let success = true;
        let errorMessage: string | undefined;
        let result: unknown;

        try {
          result = await toolDefinition.execute(args, context);
        } catch (executionError) {
          success = false;
          errorMessage = String(executionError);
          throw executionError;
        } finally {
          const durationMs = Math.round(performance.now() - startTime);
          logToolCall({
            sessionId: context.sessionId,
            toolId,
            args,
            result,
            success,
            errorMessage,
            durationMs,
          });
        }

        if ((toolId === "edit" || toolId === "write") && result) {
          const toolResult = result as ToolResult;
          const filePath = toolResult.metadata?.path as string | undefined;
          if (filePath) {
            try {
              const lsp = getLspManager();
              if (lsp) {
                await lsp.notifyFileChanged(filePath);
                const diagnostics = await lsp.getDiagnosticsForFile(filePath, { waitMs: 1500 });
                const formatted = formatDiagnostics(filePath, diagnostics);
                if (formatted) {
                  toolResult.content += formatted;
                }
              }
            } catch {
              // LSP errors should never break the tool
            }
          }
        }

        return result;
      },
      experimental_toToolResultContent: (result: unknown) => {
        const toolResult = result as { title?: string; content: string };
        const text = toolResult.title
          ? `[${toolResult.title}]\n${toolResult.content}`
          : toolResult.content;
        return [{ type: "text" as const, text }];
      },
    }) as unknown as ReturnType<typeof vercelTool>;
  }

  return resolvedTools;
}

export function getRegisteredToolIds(): string[] {
  return Array.from(registeredTools.keys());
}

export function getToolDescription(toolId: string): string | undefined {
  return registeredTools.get(toolId)?.description;
}

// Import tools here to avoid circular deps
import { bashTool } from "@/tool/bash.ts";
import { readTool } from "@/tool/read.ts";
import { writeTool } from "@/tool/write.ts";
import { editTool } from "@/tool/edit.ts";
import { globTool } from "@/tool/glob.ts";
import { grepTool } from "@/tool/grep.ts";
import { scheduleTool } from "@/tool/schedule.ts";
import { skillTool } from "@/tool/skill.ts";
import { memorySaveTool } from "@/tool/memory/save.ts";
import { memorySearchTool } from "@/tool/memory/search.ts";
import { memoryContextTool } from "@/tool/memory/context.ts";
import { taskListTool, taskGetTool, taskDeleteTool } from "@/tool/task.ts";
import { webfetchTool } from "@/tool/webfetch.ts";
import { websearchTool } from "@/tool/websearch.ts";
import { subagentTool } from "@/tool/subagent.ts";
import { questionTool } from "@/tool/question.ts";
import { todoWriteTool } from "@/tool/todo.ts";

export function initializeBuiltinTools(): void {
  registerTool(bashTool);
  registerTool(readTool);
  registerTool(writeTool);
  registerTool(editTool);
  registerTool(globTool);
  registerTool(grepTool);
  registerTool(scheduleTool);
  registerTool(skillTool);
  registerTool(memorySaveTool);
  registerTool(memorySearchTool);
  registerTool(memoryContextTool);
  registerTool(taskListTool);
  registerTool(taskGetTool);
  registerTool(taskDeleteTool);
  registerTool(webfetchTool);
  registerTool(websearchTool);
  registerTool(subagentTool);
  registerTool(questionTool);
  registerTool(todoWriteTool);
}
