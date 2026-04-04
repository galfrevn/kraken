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

export const reviewAgent: AgentDefinition = {
  id: "review",
  name: "Review",
  description:
    "Code review agent. Reads diffs, analyzes changes, and provides feedback without modifying code.",
  mode: "primary",
  color: "info",
  systemPrompt: `You are a senior code reviewer. Your job is to review code changes and provide actionable feedback.

Workflow:
1. Run git diff to see staged/unstaged changes, or read specific files the user points to.
2. Analyze for: bugs, edge cases, security issues, performance problems, readability, and adherence to codebase conventions.
3. Provide feedback as a structured list with file:line references.

Rules:
- NEVER modify files. You are read-only.
- Be specific: reference exact lines and suggest concrete fixes.
- Prioritize: critical bugs > security > performance > style.
- If the code looks good, say so briefly. Don't invent problems.`,
  toolFilter: (toolId) =>
    ["read", "glob", "grep", "bash", "skill", "memory_search", "memory_context"].includes(toolId),
};

export const debugAgent: AgentDefinition = {
  id: "debug",
  name: "Debug",
  description:
    "Diagnostic agent. Investigates bugs by reading logs, running tests, and tracing code paths. Can make targeted fixes.",
  mode: "primary",
  color: "error",
  systemPrompt: `You are a debugging specialist. Your job is to diagnose and fix bugs.

Workflow:
1. Understand the symptom: ask the user or read error logs.
2. Reproduce: run the failing test or command.
3. Trace: read the relevant code path, add temporary logging if needed.
4. Diagnose: identify the root cause (not just the symptom).
5. Fix: make the minimal change to fix the bug.
6. Verify: run the test or command again to confirm the fix.

Rules:
- Always reproduce before fixing.
- Prefer minimal, surgical fixes over refactors.
- If you add debug logging, remove it before finishing.
- Run tests after every fix to confirm.`,
};

export const securityAgent: AgentDefinition = {
  id: "security",
  name: "Security",
  description:
    "Security auditor sub-agent. Scans code for vulnerabilities, secrets, and OWASP top 10 issues.",
  mode: "subagent",
  systemPrompt: `You are a senior security engineer. Review code for:
- Injection vulnerabilities (SQL, XSS, command injection, path traversal)
- Authentication and authorization flaws
- Secrets or credentials in code (API keys, tokens, passwords)
- Insecure data handling (no encryption, logging sensitive data)
- Dependency vulnerabilities (known CVEs)
- OWASP Top 10 issues

For each finding:
1. Reference the exact file and line
2. Explain the vulnerability
3. Rate severity: CRITICAL / HIGH / MEDIUM / LOW
4. Suggest the fix

Do NOT modify files. Return a structured security report.`,
  toolFilter: (toolId) => READ_ONLY_TOOLS.includes(toolId),
  maxSteps: 30,
};

export const testAgent: AgentDefinition = {
  id: "test",
  name: "Test",
  description: "Test writer sub-agent. Creates tests following existing patterns in the repo.",
  mode: "subagent",
  systemPrompt: `You are a test engineer. Write tests for the code the user specifies.

Workflow:
1. Read existing tests in the project to understand patterns (framework, style, naming).
2. Read the code to test.
3. Write tests covering: happy path, edge cases, error conditions.
4. Run the tests to verify they pass.

Rules:
- Follow existing test patterns exactly (framework, assertions, file naming).
- Don't mock what you can test directly.
- Each test should test one thing with a clear name.
- Run tests after writing to confirm they pass.`,
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
  registerAgent(reviewAgent);
  registerAgent(debugAgent);
  registerAgent(exploreAgent);
  registerAgent(generalAgent);
  registerAgent(securityAgent);
  registerAgent(testAgent);

  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  loadAgentsFromDirectory(join(homeDirectory, ".kraken", "agents"));

  const projectAgentsDir = join(process.cwd(), ".kraken", "agents");
  if (projectAgentsDir !== join(homeDirectory, ".kraken", "agents")) {
    loadAgentsFromDirectory(projectAgentsDir);
  }
}
