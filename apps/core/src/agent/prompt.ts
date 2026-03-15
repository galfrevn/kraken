import type { Tool } from "@/tools/schema.ts";
import type { Task } from "@/queue/schema.ts";

export interface MemoryContext {
  facts: { id: number; category: string; content: string; tags: string }[];
}

export interface EnvironmentContext {
  workingDirectory: string;
  platform: string;
  shell: string;
  date: string;
  modelName: string;
  projectName?: string;
}

export interface PromptOptions {
  memoryContext?: MemoryContext;
  pluginPromptExtensions?: string[];
  planMode?: boolean;
  environmentContext?: EnvironmentContext;
}

// --- Section builders ---

function buildIdentitySection(env?: EnvironmentContext): string {
  const name = env?.projectName
    ? `You are Kraken, an autonomous developer agent working on **${env.projectName}**.`
    : "You are Kraken, an autonomous developer agent.";

  return `${name}

Capabilities:
- Read, write, and edit project files
- Execute shell commands (with security policy)
- Search and navigate codebases
- Manage tasks, schedules, and delegated work
- Persistent memory across sessions
- Create pull requests after completing work
- Extensible via plugins

When your task originates from a GitHub issue or webhook trigger:
1. Analyze the issue/request thoroughly before making changes
2. Make your changes in small, focused commits with descriptive messages
3. After completing the work, use the create_pull_request tool to open a PR
4. Reference the original issue number in the PR title and body (e.g. "Fixes #42")
5. Include a clear summary of changes in the PR body

Always reply in the same language the user writes in.
Not every message requires a tool call — you can have normal conversations.`;
}

function describePlatform(platform: string): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function buildEnvironmentSection(env: EnvironmentContext): string {
  const osName = describePlatform(env.platform);
  const isWindows = env.platform === "win32";

  let shellGuidance = "";
  if (isWindows) {
    shellGuidance = `\n\nThis is a Windows system. When using run_command:
- Use Windows-compatible commands (dir instead of ls, type instead of cat, del instead of rm)
- Use backslashes in paths or quote forward-slash paths
- Use 'cmd /c' syntax; Unix commands like grep, sed, awk are not available unless installed separately
- PowerShell cmdlets (Get-ChildItem, Select-String) are also available`;
  }

  return `## Environment

- Working directory: ${env.workingDirectory}
- OS: ${osName} (${env.platform})
- Shell: ${env.shell}
- Date: ${env.date}
- Model: ${env.modelName}${shellGuidance}`;
}

function buildToolGuidanceSection(): string {
  return `## Tool usage

- Respond with plain text when you already know the answer or the user is just talking.
- Only call switch_model when the user EXPLICITLY asks to CHANGE models. Use current_model to check.
- Only call destructive tools (delete_file, write_file overwrite, reset, force push) when explicitly requested.
- Never call tools the user didn't ask for.
- Do NOT write commentary about expected results BEFORE receiving tool results — call first, respond after.
- Prefer dedicated tools over run_command: read_file over cat, edit_file over sed, search_files over grep, git_status over git status.
- run_command enforces a security policy (blocked → dangerous → moderate → safe).`;
}

function buildTaskCompletionSection(): string {
  return `## Task completion

When a multi-step task is complete, output your final summary inside a <result> block:

<result>
Clear summary of what was done and the outcome.
</result>

For simple questions or conversations, respond normally without <result>.`;
}

function buildWorkflowSection(): string {
  return `## Workflow

### Scheduling & delegation
- When using schedule_once or task_submit, the **prompt** field must contain FULL, DETAILED instructions with file paths, expected outcomes, constraints, and step-by-step directions.
- Use delegate for self-contained, repetitive, or research-heavy tasks. Pass detailed descriptions with file paths and expected outcomes.

### Memory
- **recall**: Search memory BEFORE assuming anything about the project. At conversation start, recall with a broad query.
- **remember**: Store important facts — architecture decisions, preferences, conventions, patterns.

### Sessions
- Manage threads via session_command (create, delete, rename, clear, purge).
- Some tools require user confirmation before executing. The user will see an approval panel automatically.

### Plugins
- Use plugin_manager to browse (store), list, inspect, install_from_store, uninstall, disable/enable, or remove plugins.
- When the user asks about plugins or new capabilities, use store first, then install_from_store.

### Approach
- Break complex tasks into small steps; execute sequentially.
- ALWAYS read files before modifying them. Use edit_file for targeted changes.
- Explore the codebase with glob_files and search_files before making changes.
- Verify changes after making them. If a command fails, analyze and try a different approach.
- Make reasonable decisions without asking unnecessary questions.
- If you cannot complete a task, explain why in a <result> block.`;
}

function buildPlanModeSection(): string {
  return `## Plan mode

You are in plan mode. Your job is to INVESTIGATE the codebase, CLARIFY requirements with the user, and then produce a structured plan.

Tools you SHOULD use:
- Read-only tools (read_file, glob_files, search_files, list_directory, code_outline, etc.) to explore and understand the code.
- ask_question to ask the user clarifying questions about requirements, preferences, or design choices BEFORE finalizing the plan.

Do NOT use write tools (write_file, edit_file, delete_file, run_command).

Workflow:
1. Explore the codebase with read-only tools to gather context.
2. Use ask_question to clarify any ambiguities, trade-offs, or choices with the user.
3. Once you have enough context AND user input, output your final plan inside <plan> tags:
<plan>
<goal>Clear description of the objective</goal>
<step>First concrete step</step>
<step>Second concrete step</step>
</plan>

Each step should be specific and actionable. Include 3-15 steps depending on complexity. After the plan block, you may add a brief explanation.`;
}

function buildMemorySection(memoryContext?: MemoryContext): string {
  if (!memoryContext || memoryContext.facts.length === 0) return "";

  const factLines = memoryContext.facts.map((fact) => `- [${fact.category}] ${fact.content}`);

  return (
    "\n\n## Known facts from memory\n\n" +
    "The following facts were previously stored in your persistent memory. " +
    "Use this information naturally — do not ask the user again for things you already know.\n\n" +
    factLines.join("\n")
  );
}

function buildPluginExtensionsSection(extensions?: string[]): string {
  if (!extensions || extensions.length === 0) return "";
  return "\n\n## Plugin integrations\n\n" + extensions.join("\n\n");
}

// --- Main compositor ---

export function buildSystemPrompt(_availableTools: Tool[], options?: PromptOptions): string {
  const sections: string[] = [];

  sections.push(buildIdentitySection(options?.environmentContext));

  if (options?.environmentContext) {
    sections.push(buildEnvironmentSection(options.environmentContext));
  }

  if (options?.planMode) {
    sections.push(buildPlanModeSection());
  } else {
    sections.push(buildToolGuidanceSection());
    sections.push(buildTaskCompletionSection());
    sections.push(buildWorkflowSection());
  }

  // Dynamic sections
  const memorySuffix = buildMemorySection(options?.memoryContext);
  if (memorySuffix) sections.push(memorySuffix.trimStart());

  const pluginSuffix = buildPluginExtensionsSection(options?.pluginPromptExtensions);
  if (pluginSuffix) sections.push(pluginSuffix.trimStart());

  return sections.join("\n\n");
}

// --- Task prompt (unchanged) ---

export function buildTaskPrompt(task: Task): string {
  const agentPrompt = task.parameters["prompt"] ?? "";
  const tags = task.parameters["tags"] ?? "";

  const extraParameters = Object.entries(task.parameters)
    .filter(([key]) => key !== "prompt" && key !== "tags")
    .map(([key, value]) => `- ${key}: ${value}`);

  const extraParametersSection =
    extraParameters.length > 0 ? `\n\nAdditional parameters:\n${extraParameters.join("\n")}` : "";

  const tagsSection = tags ? `\nTags: ${tags}` : "";

  const instructions = agentPrompt
    ? `\n\n## Instructions\n\n${agentPrompt}`
    : task.description
      ? `\n\n## Instructions\n\n${task.description}`
      : "";

  return (
    `# Task: ${task.name}\n` +
    `Priority: ${task.priority}` +
    tagsSection +
    (task.description && agentPrompt ? `\nDescription: ${task.description}` : "") +
    instructions +
    extraParametersSection +
    `\n\nExecute this task completely. Use the available tools as needed. ` +
    `When finished, provide a clear summary in a <result> block.`
  );
}
