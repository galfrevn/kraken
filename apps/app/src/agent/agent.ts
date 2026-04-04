import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentModel {
  provider: string;
  model: string;
}

export type AgentColor =
  | "primary"
  | "secondary"
  | "accent"
  | "error"
  | "warning"
  | "success"
  | "info";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  mode: "primary" | "subagent" | "internal";
  systemPrompt: string;
  toolFilter?: (toolId: string) => boolean;
  model?: AgentModel;
  maxSteps?: number;
  color?: AgentColor;
}

const agentDefinitions = new Map<string, AgentDefinition>();

const READ_ONLY_TOOLS = [
  "read",
  "glob",
  "grep",
  "bash",
  "skill",
  "memory_search",
  "memory_context",
  "websearch",
  "webfetch",
];

export const buildAgent: AgentDefinition = {
  id: "build",
  name: "Build",
  description:
    "Full-access development agent. Can read, write, edit files, run commands, and make changes to the codebase.",
  mode: "primary",
  systemPrompt: "",
  color: "secondary",
};

export const planAgent: AgentDefinition = {
  id: "plan",
  name: "Plan",
  description:
    "Read-only analysis agent. Can read files and search the codebase, but cannot make changes.",
  mode: "primary",
  color: "warning",
  systemPrompt:
    "You are in read-only mode. Analyze code, answer questions, and propose plans, but do NOT modify files, run destructive commands, or make changes. Use bash only for read-only operations like git log, ls, or cat.",
  toolFilter: (toolId) =>
    [
      "read",
      "glob",
      "grep",
      "skill",
      "memory_search",
      "memory_context",
      "websearch",
      "webfetch",
      "question",
    ].includes(toolId),
};

export const exploreAgent: AgentDefinition = {
  id: "explore",
  name: "Explore",
  description:
    "Fast read-only agent for codebase exploration. Uses a cheaper/faster model. Good for searching, reading files, and gathering context.",
  mode: "subagent",
  systemPrompt:
    "You are a fast codebase exploration agent. Your job is to quickly find and return relevant code, files, and information. Be thorough but concise. Return your findings as structured text. Do NOT make changes — only read and search.",
  toolFilter: (toolId) => READ_ONLY_TOOLS.includes(toolId),
  maxSteps: 30,
};

export const generalAgent: AgentDefinition = {
  id: "general",
  name: "General",
  description:
    "General-purpose sub-agent for multi-step research and execution tasks. Has full tool access but cannot spawn further sub-agents.",
  mode: "subagent",
  systemPrompt:
    "You are a general-purpose sub-agent. Complete the given task thoroughly. You have access to all tools except spawning further sub-agents. Return a clear summary of what you did and found.",
  toolFilter: (toolId) => !["subagent", "question", "todowrite"].includes(toolId),
  maxSteps: 40,
};

export function registerAgent(agentDefinition: AgentDefinition): void {
  agentDefinitions.set(agentDefinition.id, agentDefinition);
}

export function getAgent(agentId: string): AgentDefinition | undefined {
  return agentDefinitions.get(agentId);
}

export function getAllAgents(): AgentDefinition[] {
  return Array.from(agentDefinitions.values());
}

export function getSubAgents(): AgentDefinition[] {
  return getAllAgents().filter((a) => a.mode === "subagent");
}

export function getPrimaryAgents(): AgentDefinition[] {
  return getAllAgents().filter((a) => a.mode === "primary");
}

function parseModelString(modelString: string): AgentModel | undefined {
  const slashIndex = modelString.indexOf("/");
  if (slashIndex === -1) return undefined;
  return {
    provider: modelString.slice(0, slashIndex),
    model: modelString.slice(slashIndex + 1),
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, unknown> = {};
  for (const line of fmMatch[1]!.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value: unknown = line.slice(colonIndex + 1).trim();
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (typeof value === "string" && /^\d+$/.test(value)) value = parseInt(value, 10);
    frontmatter[key] = value;
  }

  return { frontmatter, body: fmMatch[2]!.trim() };
}

function loadAgentsFromDirectory(directory: string): void {
  if (!existsSync(directory)) return;

  const files = readdirSync(directory).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    try {
      const content = readFileSync(join(directory, file), "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      const agentId = file.replace(/\.md$/, "");
      const existing = agentDefinitions.get(agentId);

      const toolsValue = frontmatter.tools;
      let toolFilter: ((toolId: string) => boolean) | undefined;
      if (typeof toolsValue === "string") {
        const allowedTools = toolsValue.split(",").map((t) => t.trim());
        toolFilter = (toolId) => allowedTools.includes(toolId);
      }

      const VALID_COLORS: AgentColor[] = [
        "primary",
        "secondary",
        "accent",
        "error",
        "warning",
        "success",
        "info",
      ];
      const rawColor = frontmatter.color as string | undefined;
      const parsedColor =
        rawColor && VALID_COLORS.includes(rawColor as AgentColor)
          ? (rawColor as AgentColor)
          : undefined;

      const agent: AgentDefinition = {
        id: agentId,
        name: (frontmatter.name as string) ?? existing?.name ?? agentId,
        description: (frontmatter.description as string) ?? existing?.description ?? "",
        mode: (frontmatter.mode as AgentDefinition["mode"]) ?? existing?.mode ?? "subagent",
        systemPrompt: body || existing?.systemPrompt || "",
        toolFilter: toolFilter ?? existing?.toolFilter,
        model: frontmatter.model ? parseModelString(frontmatter.model as string) : existing?.model,
        maxSteps: (frontmatter.maxSteps as number) ?? existing?.maxSteps,
        color: parsedColor ?? existing?.color,
      };

      registerAgent(agent);
    } catch {
      // skip malformed agent files
    }
  }
}

export function applyAgentConfigOverrides(
  agentConfigs: Record<
    string,
    { model?: string; prompt?: string; disabled?: boolean; maxSteps?: number }
  >,
): void {
  for (const [agentId, config] of Object.entries(agentConfigs)) {
    if (config.disabled) {
      agentDefinitions.delete(agentId);
      continue;
    }

    const existing = agentDefinitions.get(agentId);
    if (!existing) continue;

    if (config.model) {
      existing.model = parseModelString(config.model);
    }
    if (config.prompt) {
      existing.systemPrompt = existing.systemPrompt
        ? `${existing.systemPrompt}\n\n${config.prompt}`
        : config.prompt;
    }
    if (config.maxSteps) {
      existing.maxSteps = config.maxSteps;
    }
  }
}

export function initializeAgents(): void {
  registerAgent(buildAgent);
  registerAgent(planAgent);
  registerAgent(exploreAgent);
  registerAgent(generalAgent);

  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  loadAgentsFromDirectory(join(homeDirectory, ".kraken", "agents"));

  const projectAgentsDir = join(process.cwd(), ".kraken", "agents");
  if (projectAgentsDir !== join(homeDirectory, ".kraken", "agents")) {
    loadAgentsFromDirectory(projectAgentsDir);
  }
}
