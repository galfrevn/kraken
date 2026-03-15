import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { bold, colorize, fail, success, KRAKEN_HOME } from "@/constants.ts";
import {
  readConfigFile,
  writeConfigFile,
  appendYamlArrayItem,
  removeYamlArrayItemByName,
} from "@/yaml-writer.ts";

// ---------------------------------------------------------------------------
// YAML config types (mirrors the Rust TriggersYamlConfig)
// ---------------------------------------------------------------------------

interface CronTriggerYamlConfig {
  name: string;
  expression: string;
  task: string;
  branchPrefix?: string;
}

interface WebhookEventYamlConfig {
  type: string;
  filter?: string[];
  task: string;
}

interface WebhookTriggerYamlConfig {
  name: string;
  provider: string;
  secret: string;
  events: WebhookEventYamlConfig[];
}

interface WatcherTriggerYamlConfig {
  name: string;
  paths: string[];
  ignore?: string[];
  debounceMs?: number;
  task: string;
}

interface TriggersYamlConfig {
  crons?: CronTriggerYamlConfig[];
  webhooks?: WebhookTriggerYamlConfig[];
  watchers?: WatcherTriggerYamlConfig[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findConfigFilePath(): string | null {
  const envConfigPath = process.env.KRAKEN_CONFIGURATION_FILE;
  if (envConfigPath && existsSync(envConfigPath)) return envConfigPath;

  const globalConfigPath = join(KRAKEN_HOME, "kraken.yml");
  if (existsSync(globalConfigPath)) return globalConfigPath;

  return null;
}

function parseSimpleYamlTriggersSection(fileContents: string): TriggersYamlConfig | null {
  // Use a basic YAML parser approach -- parse the triggers section specifically.
  // For a CLI display tool this is sufficient. We parse key-value pairs with indentation.
  // For full fidelity we'd use a YAML library, but Bun doesn't have one built in,
  // and this avoids adding a dependency for a simple read-only CLI command.
  //
  // Strategy: find "triggers:" line and parse the structured content below it.

  const lines = fileContents.split("\n");
  let triggersStartIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart();
    if (trimmed.startsWith("triggers:") && lines[i]!.indexOf("triggers:") === 0) {
      triggersStartIndex = i;
      break;
    }
  }

  if (triggersStartIndex === -1) return null;

  // Collect all indented lines under "triggers:"
  const triggersLines: string[] = [];
  for (let i = triggersStartIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      triggersLines.push(line);
      continue;
    }
    // If we hit a non-indented line (a new top-level key), stop
    if (line.length > 0 && line[0] !== " " && line[0] !== "\t") break;
    triggersLines.push(line);
  }

  // Build a minimal triggers YAML string and parse manually
  const crons: CronTriggerYamlConfig[] = [];
  const webhooks: WebhookTriggerYamlConfig[] = [];
  const watchers: WatcherTriggerYamlConfig[] = [];

  let currentSection: "crons" | "webhooks" | "watchers" | null = null;
  let currentItem: Record<string, unknown> = {};
  let currentEvents: WebhookEventYamlConfig[] = [];
  let currentEvent: Record<string, unknown> = {};
  let currentList: string[] = [];
  let inListField: string | null = null;
  let inEvents = false;
  let inEvent = false;
  let eventListField: string | null = null;

  function flushCurrentEvent(): void {
    if (Object.keys(currentEvent).length > 0) {
      currentEvents.push({
        type: String(currentEvent.type || ""),
        filter: (currentEvent.filter as string[]) || [],
        task: String(currentEvent.task || ""),
      });
      currentEvent = {};
    }
  }

  function flushCurrentItem(): void {
    if (Object.keys(currentItem).length === 0) return;

    if (currentSection === "crons") {
      crons.push({
        name: String(currentItem.name || ""),
        expression: String(currentItem.expression || ""),
        task: String(currentItem.task || ""),
        branchPrefix: currentItem.branchPrefix as string | undefined,
      });
    } else if (currentSection === "webhooks") {
      flushCurrentEvent();
      webhooks.push({
        name: String(currentItem.name || ""),
        provider: String(currentItem.provider || ""),
        secret: String(currentItem.secret || ""),
        events: [...currentEvents],
      });
      currentEvents = [];
    } else if (currentSection === "watchers") {
      watchers.push({
        name: String(currentItem.name || ""),
        paths: (currentItem.paths as string[]) || [],
        ignore: (currentItem.ignore as string[]) || [],
        debounceMs: Number(currentItem.debounceMs) || 500,
        task: String(currentItem.task || ""),
      });
    }
    currentItem = {};
  }

  for (const line of triggersLines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Section headers (crons:, webhooks:, watchers:)
    if (indent === 2 && trimmed === "crons:") {
      flushCurrentItem();
      currentSection = "crons";
      inEvents = false;
      inEvent = false;
      inListField = null;
      continue;
    }
    if (indent === 2 && trimmed === "webhooks:") {
      flushCurrentItem();
      currentSection = "webhooks";
      inEvents = false;
      inEvent = false;
      inListField = null;
      continue;
    }
    if (indent === 2 && trimmed === "watchers:") {
      flushCurrentItem();
      currentSection = "watchers";
      inEvents = false;
      inEvent = false;
      inListField = null;
      continue;
    }

    // New list item (- name: value)
    if (indent === 4 && trimmed.startsWith("- ")) {
      if (inEvents && inEvent) {
        flushCurrentEvent();
        inEvent = false;
      } else {
        flushCurrentItem();
      }
      inListField = null;
      inEvents = false;
      eventListField = null;

      const itemContent = trimmed.slice(2).trim();
      const colonIndex = itemContent.indexOf(":");
      if (colonIndex > 0) {
        const key = itemContent.slice(0, colonIndex).trim();
        const value = itemContent.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
        currentItem[key] = value;
      }
      continue;
    }

    // Fields within a list item
    if (indent === 6 && !trimmed.startsWith("- ")) {
      if (inListField) {
        // We were collecting list items but now hit a non-list line
        inListField = null;
      }

      const colonIndex = trimmed.indexOf(":");
      if (colonIndex > 0) {
        const key = trimmed.slice(0, colonIndex).trim();
        const rawValue = trimmed.slice(colonIndex + 1).trim();

        if (rawValue === "" || rawValue === "[]") {
          if (key === "events") {
            inEvents = true;
            currentEvents = [];
          } else {
            inListField = key;
            currentList = [];
            currentItem[key] = currentList;
          }
        } else {
          const cleanValue = rawValue.replace(/^["']|["']$/g, "");
          currentItem[key] = cleanValue;
        }
      }
      continue;
    }

    // List items under a field (e.g., paths: \n - "src/")
    if (indent === 8 && trimmed.startsWith("- ")) {
      const listItemValue = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");

      if (inEvents) {
        // New event item
        flushCurrentEvent();
        inEvent = true;
        eventListField = null;

        const colonIndex = listItemValue.indexOf(":");
        if (colonIndex > 0) {
          const key = listItemValue.slice(0, colonIndex).trim();
          const value = listItemValue.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
          currentEvent[key] = value;
        }
      } else if (inListField) {
        currentList.push(listItemValue);
        currentItem[inListField] = [...currentList];
      }
      continue;
    }

    // Fields within an event item
    if (indent === 10 && inEvent) {
      if (eventListField && trimmed.startsWith("- ")) {
        const filterValue = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
        if (!currentEvent[eventListField]) {
          currentEvent[eventListField] = [];
        }
        (currentEvent[eventListField] as string[]).push(filterValue);
        continue;
      }

      eventListField = null;
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex > 0) {
        const key = trimmed.slice(0, colonIndex).trim();
        const rawValue = trimmed.slice(colonIndex + 1).trim();

        if (rawValue === "" || rawValue === "[]") {
          eventListField = key;
          currentEvent[key] = [];
        } else {
          currentEvent[key] = rawValue.replace(/^["']|["']$/g, "");
        }
      }
      continue;
    }

    // Filter list items inside event (indent 12)
    if (indent === 12 && trimmed.startsWith("- ") && eventListField) {
      const filterValue = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
      if (!currentEvent[eventListField]) {
        currentEvent[eventListField] = [];
      }
      (currentEvent[eventListField] as string[]).push(filterValue);
      continue;
    }
  }

  // Flush remaining
  if (inEvent) flushCurrentEvent();
  flushCurrentItem();

  return { crons, webhooks, watchers };
}

function maskSecret(secret: string): string {
  if (secret.startsWith("${")) return secret;
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function listTriggers(): void {
  const configFilePath = findConfigFilePath();

  if (!configFilePath) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  const fileContents = readFileSync(configFilePath, "utf-8");
  const triggersConfig = parseSimpleYamlTriggersSection(fileContents);

  if (
    !triggersConfig ||
    ((!triggersConfig.crons || triggersConfig.crons.length === 0) &&
      (!triggersConfig.webhooks || triggersConfig.webhooks.length === 0) &&
      (!triggersConfig.watchers || triggersConfig.watchers.length === 0))
  ) {
    console.log(`\n  No triggers configured in ${colorize(configFilePath, "dim")}`);
    console.log(`  Add a ${colorize("triggers:", "cyan")} section to your kraken.yml\n`);
    return;
  }

  console.log(`\n  ${bold("Triggers")} ${colorize(`(${configFilePath})`, "dim")}\n`);

  if (triggersConfig.crons && triggersConfig.crons.length > 0) {
    console.log(`  ${bold("Cron Triggers:")}\n`);
    for (const cronTrigger of triggersConfig.crons) {
      console.log(`    ${colorize(cronTrigger.name, "cyan")}`);
      console.log(`      Expression: ${cronTrigger.expression}`);
      console.log(`      Task:       ${cronTrigger.task}`);
      if (cronTrigger.branchPrefix) {
        console.log(`      Branch:     ${cronTrigger.branchPrefix}`);
      }
      console.log();
    }
  }

  if (triggersConfig.webhooks && triggersConfig.webhooks.length > 0) {
    console.log(`  ${bold("Webhook Triggers:")}\n`);
    for (const webhookTrigger of triggersConfig.webhooks) {
      console.log(`    ${colorize(webhookTrigger.name, "cyan")}`);
      console.log(`      Provider: ${webhookTrigger.provider}`);
      console.log(`      Secret:   ${maskSecret(webhookTrigger.secret)}`);
      for (const webhookEvent of webhookTrigger.events) {
        console.log(`      Event:    ${colorize(webhookEvent.type, "green")}`);
        if (webhookEvent.filter && webhookEvent.filter.length > 0) {
          for (const filterExpression of webhookEvent.filter) {
            console.log(`        Filter: ${filterExpression}`);
          }
        }
        console.log(`        Task:   ${webhookEvent.task}`);
      }
      console.log();
    }
  }

  if (triggersConfig.watchers && triggersConfig.watchers.length > 0) {
    console.log(`  ${bold("Watcher Triggers:")}\n`);
    for (const watcherTrigger of triggersConfig.watchers) {
      console.log(`    ${colorize(watcherTrigger.name, "cyan")}`);
      console.log(`      Paths:    ${watcherTrigger.paths.join(", ")}`);
      if (watcherTrigger.ignore && watcherTrigger.ignore.length > 0) {
        console.log(`      Ignore:   ${watcherTrigger.ignore.join(", ")}`);
      }
      console.log(`      Debounce: ${watcherTrigger.debounceMs ?? 500}ms`);
      console.log(`      Task:     ${watcherTrigger.task}`);
      console.log();
    }
  }
}

function testTrigger(triggerName: string): void {
  const configFilePath = findConfigFilePath();

  if (!configFilePath) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  const fileContents = readFileSync(configFilePath, "utf-8");
  const triggersConfig = parseSimpleYamlTriggersSection(fileContents);

  if (!triggersConfig) {
    fail("no triggers section found in kraken.yml");
    process.exit(1);
  }

  // Search across all trigger types
  const matchingCronTrigger = triggersConfig.crons?.find(
    (cronTrigger) => cronTrigger.name === triggerName,
  );
  const matchingWebhookTrigger = triggersConfig.webhooks?.find(
    (webhookTrigger) => webhookTrigger.name === triggerName,
  );
  const matchingWatcherTrigger = triggersConfig.watchers?.find(
    (watcherTrigger) => watcherTrigger.name === triggerName,
  );

  if (!matchingCronTrigger && !matchingWebhookTrigger && !matchingWatcherTrigger) {
    fail(`trigger '${triggerName}' not found in configuration`);
    console.log(`\n  Available triggers:`);

    const allTriggerNames: string[] = [];
    for (const cronTrigger of triggersConfig.crons ?? []) allTriggerNames.push(cronTrigger.name);
    for (const webhookTrigger of triggersConfig.webhooks ?? []) allTriggerNames.push(webhookTrigger.name);
    for (const watcherTrigger of triggersConfig.watchers ?? []) allTriggerNames.push(watcherTrigger.name);

    if (allTriggerNames.length === 0) {
      console.log(`    (none configured)`);
    } else {
      for (const name of allTriggerNames) {
        console.log(`    - ${colorize(name, "cyan")}`);
      }
    }
    console.log();
    process.exit(1);
  }

  console.log(`\n  ${bold("Dry run:")} trigger ${colorize(triggerName, "cyan")}\n`);

  if (matchingCronTrigger) {
    console.log(`  ${bold("Type:")} cron`);
    console.log(`  ${bold("Expression:")} ${matchingCronTrigger.expression}`);
    console.log(`  ${bold("Task template:")} ${matchingCronTrigger.task}`);

    // Simulate: cron triggers fire with a date payload
    const samplePayload = { date: new Date().toISOString().split("T")[0] };
    const renderedTaskDescription = renderTemplate(matchingCronTrigger.task, samplePayload);

    console.log(`\n  ${bold("Sample payload:")}`);
    console.log(`    ${JSON.stringify(samplePayload)}`);
    console.log(`\n  ${bold("Would create task:")}`);
    console.log(`    ${colorize(renderedTaskDescription, "green")}\n`);
  }

  if (matchingWebhookTrigger) {
    console.log(`  ${bold("Type:")} webhook`);
    console.log(`  ${bold("Provider:")} ${matchingWebhookTrigger.provider}`);

    for (const webhookEvent of matchingWebhookTrigger.events) {
      console.log(`\n  ${bold("Event:")} ${webhookEvent.type}`);
      if (webhookEvent.filter && webhookEvent.filter.length > 0) {
        console.log(`  ${bold("Filters:")}`);
        for (const filterExpression of webhookEvent.filter) {
          console.log(`    - ${filterExpression}`);
        }
      }
      console.log(`  ${bold("Task template:")} ${webhookEvent.task}`);

      const samplePayload = generateSampleWebhookPayload(
        matchingWebhookTrigger.provider,
        webhookEvent.type,
      );
      const renderedTaskDescription = renderTemplate(webhookEvent.task, samplePayload);

      console.log(`\n  ${bold("Sample payload:")}`);
      console.log(`    ${JSON.stringify(samplePayload)}`);
      console.log(`\n  ${bold("Would create task:")}`);
      console.log(`    ${colorize(renderedTaskDescription, "green")}`);
    }
    console.log();
  }

  if (matchingWatcherTrigger) {
    console.log(`  ${bold("Type:")} file watcher`);
    console.log(`  ${bold("Paths:")} ${matchingWatcherTrigger.paths.join(", ")}`);
    console.log(`  ${bold("Task template:")} ${matchingWatcherTrigger.task}`);

    const samplePayload = { path: matchingWatcherTrigger.paths[0] + "example.ts" };
    const renderedTaskDescription = renderTemplate(matchingWatcherTrigger.task, samplePayload);

    console.log(`\n  ${bold("Sample payload:")}`);
    console.log(`    ${JSON.stringify(samplePayload)}`);
    console.log(`\n  ${bold("Would create task:")}`);
    console.log(`    ${colorize(renderedTaskDescription, "green")}\n`);
  }
}

function renderTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{event\.([^}]+)\}\}/g, (_match, path: string) => {
    const segments = path.split(".");
    let current: unknown = payload;
    for (const segment of segments) {
      if (current === null || current === undefined || typeof current !== "object") return "";
      current = (current as Record<string, unknown>)[segment];
    }
    return current !== undefined && current !== null ? String(current) : "";
  });
}

function generateSampleWebhookPayload(provider: string, eventType: string): Record<string, unknown> {
  if (provider === "github") {
    if (eventType.startsWith("issues")) {
      return {
        action: eventType.split(".")[1] || "opened",
        issue: {
          title: "Example issue title",
          number: 42,
          labels: ["kraken", "bug"],
          state: "open",
        },
      };
    }
    if (eventType.startsWith("pull_request")) {
      return {
        action: eventType.split(".")[1] || "opened",
        pull_request: {
          title: "Example PR title",
          number: 99,
          head: { ref: "feature/example" },
          base: { ref: "main" },
        },
      };
    }
    if (eventType === "push") {
      return {
        ref: "refs/heads/main",
        commits: [{ message: "Example commit message" }],
      };
    }
  }

  return { action: "triggered", source: provider };
}

// ---------------------------------------------------------------------------
// Add / Remove subcommands
// ---------------------------------------------------------------------------

const TRIGGER_TYPE_OPTIONS = [
  { value: "cron", label: "Cron", hint: "run on a schedule" },
  { value: "webhook", label: "Webhook", hint: "respond to GitHub/GitLab events" },
  { value: "watcher", label: "Watcher", hint: "react to file changes" },
];

const WEBHOOK_PROVIDER_OPTIONS = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

function getAllTriggerNames(triggersConfiguration: TriggersYamlConfig): string[] {
  const allNames: string[] = [];
  for (const cronTrigger of triggersConfiguration.crons ?? []) allNames.push(cronTrigger.name);
  for (const webhookTrigger of triggersConfiguration.webhooks ?? []) allNames.push(webhookTrigger.name);
  for (const watcherTrigger of triggersConfiguration.watchers ?? []) allNames.push(watcherTrigger.name);
  return allNames;
}

async function addTriggerInteractively(): Promise<void> {
  const currentFileContents = readConfigFile();

  if (!currentFileContents) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  p.intro("Add trigger");

  const selectedTriggerType = await p.select({
    message: "Select trigger type",
    options: TRIGGER_TYPE_OPTIONS,
  });

  if (p.isCancel(selectedTriggerType)) {
    p.cancel("Cancelled.");
    return;
  }

  const existingTriggersConfiguration = parseSimpleYamlTriggersSection(currentFileContents);
  const existingTriggerNames = existingTriggersConfiguration
    ? getAllTriggerNames(existingTriggersConfiguration)
    : [];

  const triggerName = await p.text({
    message: "Trigger name",
    placeholder: "my-trigger",
    validate: (inputValue = "") => {
      if (!inputValue.trim()) return "Name is required";
      if (!/^[a-zA-Z0-9_-]+$/.test(inputValue)) return "Use only letters, numbers, hyphens, and underscores";
      if (existingTriggerNames.includes(inputValue)) return `Trigger "${inputValue}" already exists`;
    },
  });

  if (p.isCancel(triggerName)) {
    p.cancel("Cancelled.");
    return;
  }

  if (selectedTriggerType === "cron") {
    await addCronTrigger(currentFileContents, triggerName);
  } else if (selectedTriggerType === "webhook") {
    await addWebhookTrigger(currentFileContents, triggerName);
  } else if (selectedTriggerType === "watcher") {
    await addWatcherTrigger(currentFileContents, triggerName);
  }
}

async function addCronTrigger(currentFileContents: string, triggerName: string): Promise<void> {
  const cronExpression = await p.text({
    message: "Cron expression (5 fields: min hour dom month dow)",
    placeholder: "0 9 * * 1-5",
    validate: (inputValue = "") => {
      if (!inputValue.trim()) return "Cron expression is required";
      const cronFields = inputValue.trim().split(/\s+/);
      if (cronFields.length !== 5) return "Must have exactly 5 fields (minute hour day-of-month month day-of-week)";
    },
  });

  if (p.isCancel(cronExpression)) {
    p.cancel("Cancelled.");
    return;
  }

  const taskTemplate = await p.text({
    message: "Task template (use {{event.date}} for date placeholder)",
    placeholder: "Review open PRs and summarize status for {{event.date}}",
    validate: (inputValue = "") => {
      if (!inputValue.trim()) return "Task template is required";
    },
  });

  if (p.isCancel(taskTemplate)) {
    p.cancel("Cancelled.");
    return;
  }

  const branchPrefix = await p.text({
    message: "Branch prefix (optional, leave empty to skip)",
    placeholder: "kraken/review-",
  });

  if (p.isCancel(branchPrefix)) {
    p.cancel("Cancelled.");
    return;
  }

  const cronTriggerItem: Record<string, unknown> = {
    name: triggerName,
    expression: cronExpression,
    task: taskTemplate,
  };

  if (branchPrefix && branchPrefix.trim()) {
    cronTriggerItem.branchPrefix = branchPrefix;
  }

  const updatedFileContents = appendYamlArrayItem(
    currentFileContents,
    ["triggers", "crons"],
    cronTriggerItem,
  );

  writeConfigFile(updatedFileContents);
  success(`Added cron trigger "${triggerName}"`);
  p.outro("Trigger added to kraken.yml.");
}

async function addWebhookTrigger(currentFileContents: string, triggerName: string): Promise<void> {
  const selectedWebhookProvider = await p.select({
    message: "Select webhook provider",
    options: WEBHOOK_PROVIDER_OPTIONS,
  });

  if (p.isCancel(selectedWebhookProvider)) {
    p.cancel("Cancelled.");
    return;
  }

  const webhookSecret = await p.text({
    message: "Webhook secret (use ${ENV_VAR} for env variable reference)",
    placeholder: "${GITHUB_WEBHOOK_SECRET}",
    validate: (inputValue = "") => {
      if (!inputValue.trim()) return "Webhook secret is required";
    },
  });

  if (p.isCancel(webhookSecret)) {
    p.cancel("Cancelled.");
    return;
  }

  const webhookEvents: { type: string; filter: string[]; task: string }[] = [];
  let shouldAddMoreEvents = true;

  while (shouldAddMoreEvents) {
    const eventType = await p.text({
      message: "Event type (e.g. issues.opened, pull_request.opened, push)",
      placeholder: "issues.opened",
      validate: (inputValue = "") => {
        if (!inputValue.trim()) return "Event type is required";
      },
    });

    if (p.isCancel(eventType)) {
      p.cancel("Cancelled.");
      return;
    }

    const eventFilters = await p.text({
      message: "Filters (comma-separated, leave empty for none)",
      placeholder: "label:kraken, label:bug",
    });

    if (p.isCancel(eventFilters)) {
      p.cancel("Cancelled.");
      return;
    }

    const eventTaskTemplate = await p.text({
      message: "Task template for this event",
      placeholder: "Investigate issue #{{event.issue.number}}: {{event.issue.title}}",
      validate: (inputValue = "") => {
        if (!inputValue.trim()) return "Task template is required";
      },
    });

    if (p.isCancel(eventTaskTemplate)) {
      p.cancel("Cancelled.");
      return;
    }

    const parsedFilters = eventFilters && eventFilters.trim()
      ? eventFilters.split(",").map((filterValue) => filterValue.trim()).filter(Boolean)
      : [];

    webhookEvents.push({
      type: eventType,
      filter: parsedFilters,
      task: eventTaskTemplate,
    });

    const shouldContinueAddingEvents = await p.confirm({
      message: "Add another event?",
      initialValue: false,
    });

    if (p.isCancel(shouldContinueAddingEvents)) {
      p.cancel("Cancelled.");
      return;
    }

    shouldAddMoreEvents = shouldContinueAddingEvents;
  }

  const webhookTriggerItem: Record<string, unknown> = {
    name: triggerName,
    provider: selectedWebhookProvider,
    secret: webhookSecret,
    events: webhookEvents.map((webhookEvent) => {
      const eventItem: Record<string, unknown> = { type: webhookEvent.type };
      if (webhookEvent.filter.length > 0) {
        eventItem.filter = webhookEvent.filter;
      }
      eventItem.task = webhookEvent.task;
      return eventItem;
    }),
  };

  const updatedFileContents = appendYamlArrayItem(
    currentFileContents,
    ["triggers", "webhooks"],
    webhookTriggerItem,
  );

  writeConfigFile(updatedFileContents);
  success(`Added webhook trigger "${triggerName}" with ${webhookEvents.length} event(s)`);
  p.outro("Trigger added to kraken.yml.");
}

async function addWatcherTrigger(currentFileContents: string, triggerName: string): Promise<void> {
  const watchedPaths = await p.text({
    message: "Paths to watch (comma-separated)",
    placeholder: "src/, tests/",
    validate: (inputValue = "") => {
      if (!inputValue.trim()) return "At least one path is required";
    },
  });

  if (p.isCancel(watchedPaths)) {
    p.cancel("Cancelled.");
    return;
  }

  const ignorePatterns = await p.text({
    message: "Ignore patterns (comma-separated, leave empty for none)",
    placeholder: "node_modules/, .git/, *.log",
  });

  if (p.isCancel(ignorePatterns)) {
    p.cancel("Cancelled.");
    return;
  }

  const debounceMilliseconds = await p.text({
    message: "Debounce (ms)",
    placeholder: "500",
    initialValue: "500",
    validate: (inputValue = "") => {
      const parsedNumber = parseInt(inputValue, 10);
      if (Number.isNaN(parsedNumber) || parsedNumber < 0) return "Must be a positive number";
    },
  });

  if (p.isCancel(debounceMilliseconds)) {
    p.cancel("Cancelled.");
    return;
  }

  const taskTemplate = await p.text({
    message: "Task template (use {{event.path}} for changed file path)",
    placeholder: "Review changes in {{event.path}} and suggest improvements",
    validate: (inputValue = "") => {
      if (!inputValue.trim()) return "Task template is required";
    },
  });

  if (p.isCancel(taskTemplate)) {
    p.cancel("Cancelled.");
    return;
  }

  const parsedWatchedPaths = watchedPaths.split(",").map((pathValue) => pathValue.trim()).filter(Boolean);
  const parsedIgnorePatterns = ignorePatterns && ignorePatterns.trim()
    ? ignorePatterns.split(",").map((patternValue) => patternValue.trim()).filter(Boolean)
    : [];

  const watcherTriggerItem: Record<string, unknown> = {
    name: triggerName,
    paths: parsedWatchedPaths,
    task: taskTemplate,
    debounceMs: parseInt(debounceMilliseconds, 10),
  };

  if (parsedIgnorePatterns.length > 0) {
    watcherTriggerItem.ignore = parsedIgnorePatterns;
  }

  const updatedFileContents = appendYamlArrayItem(
    currentFileContents,
    ["triggers", "watchers"],
    watcherTriggerItem,
  );

  writeConfigFile(updatedFileContents);
  success(`Added watcher trigger "${triggerName}"`);
  p.outro("Trigger added to kraken.yml.");
}

function removeTrigger(triggerNameToRemove: string): void {
  const currentFileContents = readConfigFile();

  if (!currentFileContents) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  const existingTriggersConfiguration = parseSimpleYamlTriggersSection(currentFileContents);

  if (!existingTriggersConfiguration) {
    fail("no triggers section found in kraken.yml");
    process.exit(1);
  }

  const allExistingTriggerNames = getAllTriggerNames(existingTriggersConfiguration);

  if (!allExistingTriggerNames.includes(triggerNameToRemove)) {
    fail(`trigger "${triggerNameToRemove}" not found`);
    if (allExistingTriggerNames.length > 0) {
      console.log(`\n  Available triggers:`);
      for (const existingName of allExistingTriggerNames) {
        console.log(`    - ${colorize(existingName, "cyan")}`);
      }
    }
    console.log();
    process.exit(1);
  }

  let updatedFileContents = currentFileContents;

  const matchingCronTrigger = existingTriggersConfiguration.crons?.find(
    (cronTrigger) => cronTrigger.name === triggerNameToRemove,
  );
  if (matchingCronTrigger) {
    updatedFileContents = removeYamlArrayItemByName(updatedFileContents, ["triggers", "crons"], triggerNameToRemove);
  }

  const matchingWebhookTrigger = existingTriggersConfiguration.webhooks?.find(
    (webhookTrigger) => webhookTrigger.name === triggerNameToRemove,
  );
  if (matchingWebhookTrigger) {
    updatedFileContents = removeYamlArrayItemByName(updatedFileContents, ["triggers", "webhooks"], triggerNameToRemove);
  }

  const matchingWatcherTrigger = existingTriggersConfiguration.watchers?.find(
    (watcherTrigger) => watcherTrigger.name === triggerNameToRemove,
  );
  if (matchingWatcherTrigger) {
    updatedFileContents = removeYamlArrayItemByName(updatedFileContents, ["triggers", "watchers"], triggerNameToRemove);
  }

  writeConfigFile(updatedFileContents);
  success(`Removed trigger "${triggerNameToRemove}"`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printTriggerUsage(): void {
  console.log(`\n  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken trigger", "cyan")} ${colorize("<subcommand> [options]", "dim")}\n`);
  console.log(`  ${bold("Subcommands:")}\n`);
  console.log(`    ${colorize("list", "cyan")}              List all configured triggers`);
  console.log(`    ${colorize("add", "cyan")}               Interactive wizard to add a trigger`);
  console.log(`    ${colorize("remove", "cyan")} ${colorize("<name>", "dim")}     Remove a trigger from configuration`);
  console.log(`    ${colorize("test", "cyan")} ${colorize("<name>", "dim")}       Dry-run a trigger with a sample payload\n`);
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  const remainingArgs = subcommand ? args.filter((arg) => arg !== subcommand) : args;

  switch (subcommand) {
    case "list":
      listTriggers();
      break;
    case "add":
      await addTriggerInteractively();
      break;
    case "remove": {
      const triggerNameToRemoveArgument = remainingArgs.find((argument) => !argument.startsWith("-"));
      if (!triggerNameToRemoveArgument) {
        fail("missing trigger name. Usage: kraken trigger remove <name>");
        process.exit(1);
      }
      removeTrigger(triggerNameToRemoveArgument);
      break;
    }
    case "test": {
      const triggerNameArgument = remainingArgs.find((arg) => !arg.startsWith("-"));
      if (!triggerNameArgument) {
        fail("missing trigger name. Usage: kraken trigger test <name>");
        process.exit(1);
      }
      testTrigger(triggerNameArgument);
      break;
    }
    default:
      if (subcommand) {
        fail(`Unknown trigger subcommand: '${subcommand}'`);
      }
      printTriggerUsage();
      break;
  }
}
