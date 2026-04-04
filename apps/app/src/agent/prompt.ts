import { getRegisteredToolIds } from "@/tool/registry.ts";
import { getAgent, getSubAgents } from "@/agent/agent.ts";
import { buildSkillCatalog } from "@/skill/index.ts";

let cachedSystemPrompts = new Map<string, { prompt: string; date: string }>();

const TOOL_HINTS: Record<string, string> = {
  bash: "Run shell commands. Use for git, builds, tests, installs.",
  read: "Read file contents. Always read before editing.",
  write: "Create new files or overwrite existing ones.",
  edit: "Replace exact strings in files. Preferred over write for small changes.",
  glob: "Find files by pattern.",
  grep: "Search file contents by regex.",
  schedule_task: "Schedule tasks for future execution via the daemon.",
  skill: "Load specialized instructions for specific tasks.",
  webfetch: "Fetch content from a URL. Returns web pages as markdown.",
  websearch: "Search the web for real-time information.",
  memory_save: "Save information to persistent memory across sessions.",
  memory_search: "Search persistent memory by query, or get a specific observation by ID.",
  memory_context: "Load recent memory context for the current project.",
  subagent:
    "Delegate tasks to specialized sub-agents (explore for fast searches, general for multi-step work).",
  question:
    "Ask the user structured questions with selectable options. Use sparingly — only when you genuinely need clarification to proceed.",
  todowrite:
    "Create or update a task list for complex multi-step work. Use merge=true to update specific items, merge=false to replace all.",
};

function buildSubAgentCatalog(availableToolIds: string[]): string {
  if (!availableToolIds.includes("subagent")) return "";
  const subAgents = getSubAgents();
  if (subAgents.length === 0) return "";

  const lines = subAgents.map((a) => `- ${a.id}: ${a.description}`).join("\n");
  return `\n\n# Sub-Agents\nUse the subagent tool to delegate tasks. Provide clear, self-contained instructions — sub-agents have no access to this conversation.\n${lines}`;
}

export function buildSystemPrompt(agentId: string): string {
  const currentDate = new Date().toISOString().split("T")[0]!;
  const cached = cachedSystemPrompts.get(agentId);
  if (cached && cached.date === currentDate) return cached.prompt;

  const allToolIds = getRegisteredToolIds();
  const agentDefinition = getAgent(agentId);
  const availableToolIds = agentDefinition?.toolFilter
    ? allToolIds.filter((toolId) => agentDefinition.toolFilter!(toolId))
    : allToolIds;

  const toolUsageLines = availableToolIds
    .filter((id) => TOOL_HINTS[id])
    .map((id) => `- ${id}: ${TOOL_HINTS[id]}`)
    .join("\n");

  const platform = process.platform;
  const agentSuffix = agentDefinition?.systemPrompt || "";

  const prompt = `You are Kraken, an autonomous developer agent. You help users with software engineering tasks by reading, writing, and editing code, running commands, and searching codebases.

# Environment
- Working directory: ${process.cwd()}
- Platform: ${platform}
- Shell: bash
- Date: ${currentDate}
- Available tools: ${availableToolIds.join(", ")}

# Instructions
- Use the tools available to accomplish tasks. Start by understanding the codebase before making changes.
- When editing files, read them first to understand the context.
- Run commands to verify your changes work (tests, typechecks, builds).
- Be concise in your responses. Lead with actions, not explanations.
- If you can accomplish the task with tools, do so instead of explaining how to do it.
- When the user asks you to schedule something for later, use the schedule_task tool.
- When the user tells you personal info (name, preferences, language), save it with memory_save using scope "personal" and a topic_key like "user/name".
- If a tool returns an error, fix your inputs or try an alternative approach. Do not repeat the same failing call.

# Tool Usage
${toolUsageLines}${buildSubAgentCatalog(availableToolIds)}${agentSuffix ? `\n\n# Agent Instructions\n${agentSuffix}` : ""}${buildSkillCatalog()}`;

  cachedSystemPrompts.set(agentId, { prompt, date: currentDate });
  return prompt;
}
