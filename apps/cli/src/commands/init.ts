import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { KRAKEN_HOME, printBanner } from "@/constants.ts";

const LLM_PROVIDERS = [
  { value: "openrouter", label: "OpenRouter", hint: "access to all models" },
  { value: "anthropic",  label: "Anthropic",  hint: "Claude direct" },
  { value: "openai",     label: "OpenAI",     hint: "GPT direct" },
];

const MODELS_BY_PROVIDER: Record<string, { value: string; label: string; hint?: string }[]> = {
  openrouter: [
    { value: "anthropic/claude-sonnet-4",   label: "Claude Sonnet 4",   hint: "recommended" },
    { value: "deepseek/deepseek-v3.2",      label: "DeepSeek V3.2",    hint: "fast, cheap" },
    { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { value: "google/gemini-2.5-pro",       label: "Gemini 2.5 Pro" },
  ],
  anthropic: [
    { value: "claude-sonnet-4",   label: "Claude Sonnet 4" },
    { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  ],
  openai: [
    { value: "gpt-4o",  label: "GPT-4o" },
    { value: "o3-mini", label: "o3-mini" },
  ],
};

const API_KEY_ENV_BY_PROVIDER: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const SECURITY_POLICIES = [
  { value: "review_required", label: "Review required", hint: "ask before executing — recommended" },
  { value: "auto",            label: "Auto",            hint: "execute commands without asking" },
];

function generateKrakenYml(options: {
  provider: string;
  model: string;
  securityPolicy: string;
}): string {
  const lines = [
    "repo: .",
    "",
    "languageModel:",
    `  provider: ${options.provider}`,
    `  model: ${options.model}`,
    "  temperature: 0.7",
    "  maxTokens: 16384",
    "",
    "security:",
    `  defaultPolicy: ${options.securityPolicy}`,
    "  rules:",
    "    - trigger: manual",
    "      policy: auto",
    "    - trigger: cron",
    "      policy: review_required",
    "    - trigger: webhook",
    "      policy: review_required",
    "    - trigger: file_change",
    "      policy: review_required",
    "    - trigger: companion",
    "      policy: review_required",
    "",
    "git:",
    "  branchPrefix: kraken/",
    "  autoCommit: true",
    '  commitPrefix: "kraken:"',
    "",
    "services:",
    "  schedulerUrl: http://localhost:50051",
    "  gatewayUrl: http://localhost:50052",
    "",
    "scheduler:",
    "  crons: []",
    "  watchers: []",
  ];

  return lines.join("\n") + "\n";
}

function ensureCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return value;
}

export async function execute(_args: string[]): Promise<void> {
  printBanner();

  p.intro("Initialize kraken");

  const configPath = join(KRAKEN_HOME, "kraken.yml");
  const envPath = join(KRAKEN_HOME, ".env");
  const pluginsPath = join(KRAKEN_HOME, "plugins");

  if (existsSync(configPath)) {
    const shouldOverwrite = ensureCancel(await p.confirm({
      message: `~/.kraken/kraken.yml already exists. Overwrite?`,
      initialValue: false,
    }));

    if (!shouldOverwrite) {
      p.cancel("Aborted.");
      return;
    }
  }

  const provider = ensureCancel(await p.select({
    message: "Select LLM provider",
    options: LLM_PROVIDERS,
  }));

  const modelsForProvider = MODELS_BY_PROVIDER[provider];
  if (!modelsForProvider) {
    p.log.error(`No models available for provider "${provider}"`);
    process.exit(1);
  }

  const model = ensureCancel(await p.select({
    message: "Select model",
    options: modelsForProvider,
  }));

  let apiKey = "";
  const envVarName = API_KEY_ENV_BY_PROVIDER[provider] ?? "OPENROUTER_API_KEY";
  const existingKey = Bun.env[envVarName];

  if (existingKey) {
    const masked = `${existingKey.slice(0, 10)}...${existingKey.slice(-4)}`;
    const useExistingKey = ensureCancel(await p.confirm({
      message: `Found ${envVarName} in environment (${masked}). Use it?`,
      initialValue: true,
    }));

    if (useExistingKey) {
      apiKey = existingKey;
    }
  }

  if (!apiKey) {
    apiKey = ensureCancel(await p.text({
      message: `Enter your ${provider} API key`,
      placeholder: "sk-...",
      validate: (value = "") => {
        if (!value.trim()) return "API key is required for LLM access";
      },
    }));
  }

  const securityPolicy = ensureCancel(await p.select({
    message: "Select default security policy",
    options: SECURITY_POLICIES,
  }));

  const spinnerInstance = p.spinner();
  spinnerInstance.start("Creating configuration in ~/.kraken/");

  mkdirSync(KRAKEN_HOME, { recursive: true });
  mkdirSync(pluginsPath, { recursive: true });

  const yamlContent = generateKrakenYml({ provider, model, securityPolicy });
  writeFileSync(configPath, yamlContent);

  const envContent = `# Kraken - Environment Variables\n${envVarName}=${apiKey}\n`;
  writeFileSync(envPath, envContent);

  spinnerInstance.stop("Configuration created");

  p.log.success(`~/.kraken/kraken.yml`);
  p.log.success(`~/.kraken/.env`);
  p.log.success(`~/.kraken/plugins/`);

  // --- Plugin installation step ---
  let registryPlugins: { name: string; version: string; description: string; tools: string[]; requires: string[] }[] = [];

  const pluginSpinner = p.spinner();
  pluginSpinner.start("Fetching plugin registry...");

  try {
    const registryUrl = "https://raw.githubusercontent.com/galfrevn/kraken/main/packages/plugins/registry.json";
    const response = await fetch(registryUrl, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const registry = (await response.json()) as { plugins: typeof registryPlugins };
      registryPlugins = registry.plugins;
      pluginSpinner.stop(`Found ${registryPlugins.length} plugins`);
    } else {
      pluginSpinner.stop("Could not fetch plugin registry (skipping)");
    }
  } catch {
    pluginSpinner.stop("Could not fetch plugin registry (skipping)");
  }

  if (registryPlugins.length > 0) {
    const pluginChoices = registryPlugins.map((plugin) => ({
      value: plugin.name,
      label: plugin.name,
      hint: plugin.description,
    }));

    const selectedPlugins = ensureCancel(await p.multiselect({
      message: "Select plugins to install",
      options: pluginChoices,
      required: false,
    }));

    if (selectedPlugins.length > 0) {
      const installSpinner = p.spinner();
      installSpinner.start(`Installing ${selectedPlugins.length} plugin(s)...`);

      const installed: string[] = [];
      const failed: string[] = [];

      for (const pluginName of selectedPlugins) {
        const plugin = registryPlugins.find((pl) => pl.name === pluginName);
        if (!plugin) continue;

        try {
          const sourceUrl = `https://raw.githubusercontent.com/galfrevn/kraken/main/packages/plugins/${pluginName}/index.ts`;
          const sourceResponse = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) });

          if (sourceResponse.ok) {
            const sourceCode = await sourceResponse.text();
            const pluginDir = join(pluginsPath, pluginName);
            mkdirSync(pluginDir, { recursive: true });
            writeFileSync(join(pluginDir, "index.ts"), sourceCode, "utf-8");
            installed.push(pluginName);
          } else {
            failed.push(pluginName);
          }
        } catch {
          failed.push(pluginName);
        }
      }

      installSpinner.stop("Plugins installed");

      for (const name of installed) {
        const plugin = registryPlugins.find((pl) => pl.name === name);
        p.log.success(`${name} — ${plugin?.tools.length ?? 0} tools`);
        if (plugin?.requires.length) {
          p.log.warn(`  requires: ${plugin.requires.join(", ")}`);
        }
      }
      for (const name of failed) {
        p.log.error(`${name} — failed to download`);
      }
    }
  }

  p.note(
    `Global config: ~/.kraken/kraken.yml\nPlugins:       ~/.kraken/plugins/\nDatabase:      ~/.kraken/agent.db\n\nKraken will use this config from any directory.`,
    "Global configuration",
  );

  p.outro("Setup complete! Run kraken to start.");
}
