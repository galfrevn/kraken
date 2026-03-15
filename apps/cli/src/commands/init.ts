import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { KRAKEN_HOME, printBanner } from "@/constants.ts";
import { LLM_PROVIDERS, MODELS_BY_PROVIDER, API_KEY_ENV_VAR_BY_PROVIDER } from "@/providers.ts";
import { appendYamlArrayItem } from "@/yaml-writer.ts";

const SECURITY_POLICIES = [
  {
    value: "review_required",
    label: "Review required",
    hint: "ask before executing — recommended",
  },
  { value: "auto", label: "Auto", hint: "execute commands without asking" },
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
    "",
    "triggers:",
    "  crons: []",
    "  webhooks: []",
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
    const shouldOverwrite = ensureCancel(
      await p.confirm({
        message: `~/.kraken/kraken.yml already exists. Overwrite?`,
        initialValue: false,
      }),
    );

    if (!shouldOverwrite) {
      p.cancel("Aborted.");
      return;
    }
  }

  const provider = ensureCancel(
    await p.select({
      message: "Select LLM provider",
      options: LLM_PROVIDERS,
    }),
  );

  const modelsForProvider = MODELS_BY_PROVIDER[provider];
  if (!modelsForProvider) {
    p.log.error(`No models available for provider "${provider}"`);
    process.exit(1);
  }

  const model = ensureCancel(
    await p.select({
      message: "Select model",
      options: modelsForProvider,
    }),
  );

  let apiKey = "";
  const envVarName = API_KEY_ENV_VAR_BY_PROVIDER[provider] ?? "OPENROUTER_API_KEY";
  const existingKey = Bun.env[envVarName];

  if (existingKey) {
    const masked = `${existingKey.slice(0, 10)}...${existingKey.slice(-4)}`;
    const useExistingKey = ensureCancel(
      await p.confirm({
        message: `Found ${envVarName} in environment (${masked}). Use it?`,
        initialValue: true,
      }),
    );

    if (useExistingKey) {
      apiKey = existingKey;
    }
  }

  if (!apiKey) {
    apiKey = ensureCancel(
      await p.text({
        message: `Enter your ${provider} API key`,
        placeholder: "sk-...",
        validate: (value = "") => {
          if (!value.trim()) return "API key is required for LLM access";
        },
      }),
    );
  }

  const securityPolicy = ensureCancel(
    await p.select({
      message: "Select default security policy",
      options: SECURITY_POLICIES,
    }),
  );

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
  let registryPlugins: {
    name: string;
    version: string;
    description: string;
    tools: string[];
    requires: string[];
  }[] = [];

  const pluginSpinner = p.spinner();
  pluginSpinner.start("Fetching plugin registry...");

  try {
    const registryUrl =
      "https://raw.githubusercontent.com/galfrevn/kraken/main/packages/plugins/registry.json";
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

    const selectedPlugins = ensureCancel(
      await p.multiselect({
        message: "Select plugins to install",
        options: pluginChoices,
        required: false,
      }),
    );

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

  const shouldSetupNotifications = ensureCancel(
    await p.confirm({
      message: "Set up a notification channel?",
      initialValue: false,
    }),
  );

  if (shouldSetupNotifications) {
    const notificationProviderSelection = ensureCancel(
      await p.select({
        message: "Notification provider",
        options: [
          { value: "slack", label: "Slack", hint: "webhook URL" },
          { value: "discord", label: "Discord", hint: "webhook URL" },
          { value: "system", label: "System", hint: "desktop notifications" },
        ],
      }),
    );

    let notificationChannelItem: Record<string, unknown> = {
      name: `${notificationProviderSelection}-alerts`,
      provider: notificationProviderSelection,
      events: ["task.completed", "task.failed"],
    };

    if (notificationProviderSelection === "slack" || notificationProviderSelection === "discord") {
      const notificationWebhookUrl = ensureCancel(
        await p.text({
          message: `Enter ${notificationProviderSelection} webhook URL`,
          placeholder: "https://hooks.slack.com/services/...",
          validate: (inputValue = "") => {
            if (!inputValue.trim()) return "Webhook URL is required";
            if (!inputValue.startsWith("https://")) return "URL must start with https://";
          },
        }),
      );

      notificationChannelItem.url = notificationWebhookUrl;
    }

    let currentConfigContents = readFileSync(configPath, "utf-8");
    currentConfigContents = appendYamlArrayItem(
      currentConfigContents,
      ["notifications", "channels"],
      notificationChannelItem,
    );
    writeFileSync(configPath, currentConfigContents);
    p.log.success(`Added ${notificationProviderSelection} notification channel`);
  }

  const shouldSetupTrigger = ensureCancel(
    await p.confirm({
      message: "Set up a trigger?",
      initialValue: false,
    }),
  );

  if (shouldSetupTrigger) {
    const triggerPresetSelection = ensureCancel(
      await p.select({
        message: "Select a trigger preset",
        options: [
          { value: "daily-review", label: "Daily code review", hint: "9am weekdays" },
          { value: "github-issues", label: "GitHub issue handler", hint: "auto-respond to issues" },
          { value: "custom-cron", label: "Custom cron", hint: "define your own schedule" },
        ],
      }),
    );

    let currentConfigContents = readFileSync(configPath, "utf-8");

    if (triggerPresetSelection === "daily-review") {
      currentConfigContents = appendYamlArrayItem(
        currentConfigContents,
        ["triggers", "crons"],
        {
          name: "daily-review",
          expression: "0 9 * * 1-5",
          task: "Review open PRs and summarize status for {{event.date}}",
        },
      );
    } else if (triggerPresetSelection === "github-issues") {
      currentConfigContents = appendYamlArrayItem(
        currentConfigContents,
        ["triggers", "webhooks"],
        {
          name: "github-issues",
          provider: "github",
          secret: "${GITHUB_WEBHOOK_SECRET}",
          events: [
            { type: "issues.opened", filter: ["label:kraken"], task: "Investigate issue #{{event.issue.number}}: {{event.issue.title}}" },
          ],
        },
      );
    } else if (triggerPresetSelection === "custom-cron") {
      const customCronExpression = ensureCancel(
        await p.text({
          message: "Cron expression (min hour dom month dow)",
          placeholder: "0 9 * * 1-5",
          validate: (inputValue = "") => {
            if (!inputValue.trim()) return "Cron expression is required";
            const cronFields = inputValue.trim().split(/\s+/);
            if (cronFields.length !== 5) return "Must have exactly 5 fields";
          },
        }),
      );

      const customCronTask = ensureCancel(
        await p.text({
          message: "Task template",
          placeholder: "Run daily maintenance tasks",
          validate: (inputValue = "") => {
            if (!inputValue.trim()) return "Task template is required";
          },
        }),
      );

      currentConfigContents = appendYamlArrayItem(
        currentConfigContents,
        ["triggers", "crons"],
        {
          name: "custom-cron",
          expression: customCronExpression,
          task: customCronTask,
        },
      );
    }

    writeFileSync(configPath, currentConfigContents);
    p.log.success(`Added ${triggerPresetSelection} trigger`);
  }

  p.note(
    `Global config: ~/.kraken/kraken.yml\nPlugins:       ~/.kraken/plugins/\nDatabase:      ~/.kraken/agent.db\n\nKraken will use this config from any directory.`,
    "Global configuration",
  );

  p.outro("Setup complete! Run kraken to start.");
}
