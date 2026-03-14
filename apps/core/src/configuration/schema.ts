import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const KRAKEN_HOME = resolve(homedir(), ".kraken");

const languageModelConfigurationSchema = z.object({
  provider: z.enum(["openrouter", "openai", "anthropic", "ollama"]).default("openrouter"),
  model: z.string().default("deepseek/deepseek-v3.2"),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().positive().default(16384),
});

const securityRuleSchema = z.object({
  trigger: z.enum(["cron", "webhook", "file_change", "manual", "companion"]),
  policy: z.enum(["auto", "review_required"]),
});

const defaultSecurityRules: z.input<typeof securityRuleSchema>[] = [
  { trigger: "manual", policy: "auto" },
  { trigger: "cron", policy: "review_required" },
  { trigger: "webhook", policy: "review_required" },
  { trigger: "file_change", policy: "review_required" },
  { trigger: "companion", policy: "review_required" },
];

const securityConfigurationSchema = z.object({
  defaultPolicy: z.enum(["auto", "review_required"]).default("review_required"),
  rules: z.array(securityRuleSchema).default(defaultSecurityRules),
});

const cronJobConfigurationSchema = z.object({
  name: z.string(),
  expression: z.string(),
  task: z.string(),
  parameters: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

const watcherConfigurationSchema = z.object({
  name: z.string(),
  paths: z.array(z.string()),
  ignore: z.array(z.string()).default(["node_modules", ".git", "target", "dist"]),
  debounceMs: z.number().positive().default(500),
});

const schedulerConfigurationSchema = z.object({
  crons: z.array(cronJobConfigurationSchema).default([]),
  watchers: z.array(watcherConfigurationSchema).default([]),
});

const commandPolicySchema = z.object({
  allowedPrefixes: z.array(z.string()).default([]),
  blockedPrefixes: z.array(z.string()).default([]),
  allowUnknown: z.boolean().default(true),
  requireConfirmationAbove: z
    .enum(["safe", "moderate", "dangerous", "blocked"])
    .default("dangerous"),
});

const gitConfigurationSchema = z.object({
  branchPrefix: z.string().default("kraken/"),
  autoCommit: z.boolean().default(true),
  commitPrefix: z.string().default("kraken:"),
});

const subagentConfigurationSchema = z.object({
  defaultModel: z.string().optional(),
  maxIterations: z.number().positive().default(25),
});

const servicesConfigurationSchema = z.object({
  schedulerUrl: z.string().default("http://localhost:50051"),
  gatewayUrl: z.string().default("http://localhost:50052"),
});

export const agentConfigurationSchema = z
  .object({
    repo: z.string().default("."),
    databasePath: z
      .string()
      .default(resolve(KRAKEN_HOME, "agent.db"))
      .transform((p) => (isAbsolute(p) ? p : resolve(KRAKEN_HOME, p))),
    languageModel: languageModelConfigurationSchema.optional(),
    security: securityConfigurationSchema.optional(),
    scheduler: schedulerConfigurationSchema.optional(),
    commands: commandPolicySchema.optional(),
    git: gitConfigurationSchema.optional(),
    services: servicesConfigurationSchema.optional(),
    subagent: subagentConfigurationSchema.optional(),
    plugins: z
      .array(
        z.union([
          z.string().transform((path) => ({ path, config: {} as Record<string, unknown> })),
          z.object({
            path: z.string(),
            config: z.record(z.string(), z.unknown()).default({}),
          }),
        ]),
      )
      .default([]),
  })
  .transform((data) => ({
    repo: data.repo,
    databasePath: data.databasePath,
    languageModel: languageModelConfigurationSchema.parse(data.languageModel ?? {}),
    security: securityConfigurationSchema.parse(data.security ?? {}),
    scheduler: schedulerConfigurationSchema.parse(data.scheduler ?? {}),
    commands: commandPolicySchema.parse(data.commands ?? {}),
    git: gitConfigurationSchema.parse(data.git ?? {}),
    services: servicesConfigurationSchema.parse(data.services ?? {}),
    subagent: subagentConfigurationSchema.parse(data.subagent ?? {}),
    plugins: data.plugins,
  }));

export type AgentConfiguration = z.output<typeof agentConfigurationSchema>;
export type LanguageModelConfiguration = z.infer<typeof languageModelConfigurationSchema>;
export type SecurityConfiguration = z.infer<typeof securityConfigurationSchema>;
export type SchedulerConfiguration = z.infer<typeof schedulerConfigurationSchema>;
export type GitConfiguration = z.infer<typeof gitConfigurationSchema>;
export type CommandPolicyConfiguration = z.infer<typeof commandPolicySchema>;
export type SubagentConfiguration = z.infer<typeof subagentConfigurationSchema>;
export type CronJobConfiguration = z.infer<typeof cronJobConfigurationSchema>;
export type WatcherConfiguration = z.infer<typeof watcherConfigurationSchema>;
