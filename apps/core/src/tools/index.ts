export { ToolRegistry } from "@/tools/registry.ts";
export { formatToolDefinitionsForPrompt, toolsToNativeFormat } from "@/tools/schema.ts";
export type { NativeTool } from "@/tools/schema.ts";

export { readFileTool } from "@/tools/reader.ts";
export { writeFileTool } from "@/tools/writer.ts";
export { editFileTool } from "@/tools/editor.ts";
export { createRunCommandTool } from "@/tools/executor.ts";
export { evaluateCommandPolicy, classifyCommand } from "@/tools/policy.ts";
export { listDirectoryTool } from "@/tools/lister.ts";
export { searchFilesTool } from "@/tools/searcher.ts";
export { globFilesTool } from "@/tools/globber.ts";
export {
  readLinesTool,
  deleteFileTool,
  moveFileTool,
  replaceInFilesTool,
} from "@/tools/filesystem.ts";
export { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool, createPullRequestTool } from "@/tools/git.ts";
export { webSearchTool, fetchUrlTool } from "@/tools/browser.ts";
export { httpRequestTool } from "@/tools/http.ts";
export { diffFilesTool } from "@/tools/diff.ts";
export { codeOutlineTool } from "@/tools/outline.ts";
export { environmentTool } from "@/tools/environment.ts";
export { countTokensTool } from "@/tools/tokens.ts";
export {
  createCurrentModelTool,
  createModelSwitchTool,
  createModelListTool,
} from "@/tools/model.ts";
export { createDelegateTool } from "@/tools/delegate.ts";
export { createRememberTool, createRecallTool, createIndexProjectTool } from "@/tools/memory.ts";
export { createTaskListTool, createTaskSubmitTool } from "@/tools/tasks.ts";
export { createSessionCommandTool } from "@/tools/session.ts";
export type { SessionCommandExecutor, SessionCommandDefinition } from "@/tools/session.ts";
export {
  createAskQuestionTool,
  type PendingQuestions,
  type QuestionItem,
  type QuestionOption,
  type QuestionAnswer,
  type QuestionHandler,
} from "@/tools/question.ts";
export { viewImageTool } from "@/tools/vision.ts";

export type {
  Tool,
  ToolDefinition,
  ToolParameterDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolProgressEvent,
  ToolProgressCallback,
} from "@/tools/schema.ts";

import { ToolRegistry } from "@/tools/registry.ts";
import { readFileTool } from "@/tools/reader.ts";
import { writeFileTool } from "@/tools/writer.ts";
import { editFileTool } from "@/tools/editor.ts";
import { createRunCommandTool } from "@/tools/executor.ts";
import { listDirectoryTool } from "@/tools/lister.ts";
import { searchFilesTool } from "@/tools/searcher.ts";
import { globFilesTool } from "@/tools/globber.ts";
import {
  readLinesTool,
  deleteFileTool,
  moveFileTool,
  replaceInFilesTool,
} from "@/tools/filesystem.ts";
import { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool, createPullRequestTool } from "@/tools/git.ts";
import { webSearchTool, fetchUrlTool } from "@/tools/browser.ts";
import { httpRequestTool } from "@/tools/http.ts";
import { diffFilesTool } from "@/tools/diff.ts";
import { codeOutlineTool } from "@/tools/outline.ts";
import { environmentTool } from "@/tools/environment.ts";
import { countTokensTool } from "@/tools/tokens.ts";
import {
  createCurrentModelTool,
  createModelSwitchTool,
  createModelListTool,
} from "@/tools/model.ts";
import { createTaskListTool, createTaskSubmitTool } from "@/tools/tasks.ts";
import { createDelegateTool } from "@/tools/delegate.ts";
import { createRememberTool, createRecallTool, createIndexProjectTool } from "@/tools/memory.ts";
import { viewImageTool } from "@/tools/vision.ts";
import type { LanguageModelClient } from "@/language/client.ts";
import type { TaskQueueManager } from "@/queue/manager.ts";
import type { AgentDatabase } from "@/storage/database.ts";
import type { CommandPolicyConfiguration } from "@/configuration/schema.ts";
import type { Tool } from "@/tools/schema.ts";

export interface ToolRegistryOptions {
  languageModelClient?: LanguageModelClient;
  taskQueueManager?: TaskQueueManager;
  database?: AgentDatabase;
  commandPolicy?: CommandPolicyConfiguration;
  workingDirectory?: string;
  mcpTools?: Tool[];
  profile?: "chat" | "daemon" | "cli";
}

export function createDefaultToolRegistry(options?: ToolRegistryOptions): ToolRegistry {
  const profile = options?.profile ?? "daemon";
  const registry = new ToolRegistry();

  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(readLinesTool);
  registry.register(deleteFileTool);
  registry.register(moveFileTool);
  registry.register(replaceInFilesTool);
  registry.register(createRunCommandTool(options?.commandPolicy));
  registry.register(listDirectoryTool);
  registry.register(searchFilesTool);
  registry.register(globFilesTool);
  registry.register(diffFilesTool);
  registry.register(codeOutlineTool);
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitCommitTool);
  registry.register(gitLogTool);
  registry.register(createPullRequestTool);
  registry.register(webSearchTool);
  registry.register(fetchUrlTool);
  registry.register(httpRequestTool);
  registry.register(environmentTool);
  if (profile !== "chat" && profile !== "cli") {
    registry.register(countTokensTool);
  }
  registry.register(viewImageTool);
  registry.register(createModelListTool());

  if (options?.languageModelClient) {
    registry.register(createCurrentModelTool(options.languageModelClient));
    registry.register(createModelSwitchTool(options.languageModelClient));
    registry.register(
      createDelegateTool(options.languageModelClient, registry, options.workingDirectory ?? "."),
    );
  }

  if (options?.database) {
    registry.register(createRememberTool(options.database));
    registry.register(createRecallTool(options.database));
    if (profile !== "chat" && profile !== "cli") {
      registry.register(createIndexProjectTool(options.database));
    }
  }

  if (options?.taskQueueManager) {
    if (profile !== "chat" && profile !== "cli") {
      registry.register(createTaskListTool(options.taskQueueManager));
      registry.register(createTaskSubmitTool(options.taskQueueManager));
    }
  }

  if (options?.mcpTools) {
    for (const mcpTool of options.mcpTools) {
      registry.register(mcpTool);
    }
  }

  return registry;
}
