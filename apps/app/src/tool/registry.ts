import { tool as vercelTool } from "ai";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { ToolDefinition } from "@/tool/tool.ts";
import type { ToolResult } from "@/tool/tool.ts";
import { logToolCall } from "@/audit/index.ts";
import { getLspManager, formatDiagnostics } from "@/lsp/manager.ts";
import { requestPermission, type PermissionRequest } from "@/tool/permission.ts";
import { isAllowed } from "@/tool/permission-allowlist.ts";
import { loadConfig } from "@/config/index.ts";
import { createUnifiedDiff } from "@/util/diff.ts";

const registeredTools = new Map<string, ToolDefinition>();
const sessionToolCallCounts = new Map<string, number>();

const DEFAULT_TOOL_CALLS_PER_SESSION = 200;
const PERMISSION_TOOLS = new Set(["edit", "write", "bash"]);

function needsPermission(
  toolId: string,
  args: unknown,
  context: { workingDirectory: string },
): boolean {
  const config = loadConfig();
  if (config.permissions?.mode !== "ask") return false;
  if (!PERMISSION_TOOLS.has(toolId)) return false;

  const parsed = args as Record<string, unknown>;
  const target = (parsed.filePath as string) ?? (parsed.command as string) ?? toolId;
  const fullTarget = toolId === "bash" ? target : resolve(context.workingDirectory, target);

  return !isAllowed(toolId, fullTarget);
}

function buildPermissionRequest(
  toolId: string,
  args: unknown,
  context: { workingDirectory: string },
): PermissionRequest {
  const parsed = args as Record<string, unknown>;
  const id = crypto.randomUUID();

  if (toolId === "edit") {
    const filePath = parsed.filePath as string;
    const absolutePath = resolve(context.workingDirectory, filePath);
    let diff: string | undefined;
    if (existsSync(absolutePath)) {
      const original = readFileSync(absolutePath, "utf-8");
      const oldStr = parsed.oldString as string;
      const newStr = parsed.newString as string;
      if (original.includes(oldStr)) {
        const updated = original.replace(oldStr, newStr);
        diff = createUnifiedDiff(filePath, original, updated);
      }
    }
    return { id, toolId, filepath: filePath, diff };
  }

  if (toolId === "write") {
    const filePath = parsed.filePath as string;
    return { id, toolId, filepath: filePath };
  }

  if (toolId === "bash") {
    return { id, toolId, command: parsed.command as string };
  }

  return { id, toolId };
}

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

        if (needsPermission(toolId, args, context)) {
          const request = buildPermissionRequest(toolId, args, context);
          const approved = await requestPermission(context.sessionId, context.messageId, request);
          if (!approved) {
            return { title: toolId, content: "Permission denied by user." };
          }
        }

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
import { channelSendTool } from "@/tool/channel-send.ts";
import {
  githubPrListTool,
  githubPrGetTool,
  githubPrCreateTool,
  githubPrCommentTool,
  githubPrMergeTool,
  githubIssueListTool,
  githubIssueCreateTool,
} from "@/tool/github.ts";

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
  registerTool(channelSendTool);
  registerTool(githubPrListTool);
  registerTool(githubPrGetTool);
  registerTool(githubPrCreateTool);
  registerTool(githubPrCommentTool);
  registerTool(githubPrMergeTool);
  registerTool(githubIssueListTool);
  registerTool(githubIssueCreateTool);
}
