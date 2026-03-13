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
export { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool } from "@/tools/git.ts";
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
export {
  createScheduleCronTool,
  createListSchedulesTool,
  createDeleteScheduleTool,
  createScheduleWatcherTool,
  createDeleteWatcherTool,
} from "@/tools/scheduler.ts";
export {
  createScheduleOnceTool,
  createListTimersTool,
  createCancelTimerTool,
} from "@/tools/timers.ts";
export { createSessionCommandTool } from "@/tools/session.ts";
export type { SessionCommandExecutor, SessionCommandDefinition } from "@/tools/session.ts";
export { createPluginManagerTool, type PluginManagerDependencies } from "@/tools/plugins.ts";
export { createAskQuestionTool, type PendingQuestions, type QuestionItem, type QuestionOption, type QuestionAnswer, type QuestionHandler } from "@/tools/question.ts";
export { viewImageTool } from "@/tools/vision.ts";

export type {
  Tool,
  ToolDefinition,
  ToolParameterDefinition,
  ToolExecutionContext,
  ToolResult,
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
import { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool } from "@/tools/git.ts";
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
import {
  createScheduleCronTool,
  createListSchedulesTool,
  createDeleteScheduleTool,
  createScheduleWatcherTool,
  createDeleteWatcherTool,
} from "@/tools/scheduler.ts";
import {
  createScheduleOnceTool,
  createListTimersTool,
  createCancelTimerTool,
} from "@/tools/timers.ts";
import { createDelegateTool } from "@/tools/delegate.ts";
import { createRememberTool, createRecallTool, createIndexProjectTool } from "@/tools/memory.ts";
import { viewImageTool } from "@/tools/vision.ts";
import type { LanguageModelClient } from "@/language/client.ts";
import type { SchedulerClient } from "@/clients/scheduler.ts";
import type { TaskQueueManager } from "@/queue/manager.ts";
import type { TimerManager } from "@/scheduling/timers.ts";
import type { AgentDatabase } from "@/storage/database.ts";
import type { CommandPolicyConfiguration } from "@/configuration/schema.ts";
import type { Tool } from "@/tools/schema.ts";

export interface ToolRegistryOptions {
  languageModelClient?: LanguageModelClient;
  schedulerClient?: SchedulerClient;
  taskQueueManager?: TaskQueueManager;
  timerManager?: TimerManager;
  database?: AgentDatabase;
  commandPolicy?: CommandPolicyConfiguration;
  workingDirectory?: string;
  pluginTools?: Tool[];
}

export function createDefaultToolRegistry(options?: ToolRegistryOptions): ToolRegistry {
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
  registry.register(webSearchTool);
  registry.register(fetchUrlTool);
  registry.register(httpRequestTool);
  registry.register(environmentTool);
  registry.register(countTokensTool);
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
    registry.register(createIndexProjectTool(options.database));
  }

  if (options?.taskQueueManager) {
    registry.register(createTaskListTool(options.taskQueueManager));
    registry.register(createTaskSubmitTool(options.taskQueueManager));
  }

  if (options?.timerManager) {
    registry.register(createScheduleOnceTool(options.timerManager));
    registry.register(createListTimersTool(options.timerManager));
    registry.register(createCancelTimerTool(options.timerManager));
  }

  if (options?.schedulerClient) {
    registry.register(createScheduleCronTool(options.schedulerClient));
    registry.register(createListSchedulesTool(options.schedulerClient));
    registry.register(createDeleteScheduleTool(options.schedulerClient));
    registry.register(createScheduleWatcherTool(options.schedulerClient));
    registry.register(createDeleteWatcherTool(options.schedulerClient));
  }

  if (options?.pluginTools) {
    for (const tool of options.pluginTools) {
      registry.register(tool);
    }
  }

  return registry;
}
