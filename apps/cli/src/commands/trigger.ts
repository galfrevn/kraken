import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bold, colorize, fail, warn, KRAKEN_HOME } from "@/constants.ts";

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

interface KrakenYamlConfig {
  triggers?: TriggersYamlConfig;
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
// Entry point
// ---------------------------------------------------------------------------

function printTriggerUsage(): void {
  console.log(`\n  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken trigger", "cyan")} ${colorize("<subcommand> [options]", "dim")}\n`);
  console.log(`  ${bold("Subcommands:")}\n`);
  console.log(`    ${colorize("list", "cyan")}            List all configured triggers`);
  console.log(`    ${colorize("test", "cyan")} ${colorize("<name>", "dim")}     Dry-run a trigger with a sample payload\n`);
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  const remainingArgs = subcommand ? args.filter((arg) => arg !== subcommand) : args;

  switch (subcommand) {
    case "list":
      listTriggers();
      break;
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
