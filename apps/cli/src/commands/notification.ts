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
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { DaemonService } from "@gen/agent/v1/daemon_pb.ts";

const NOTIFICATION_PROVIDER_OPTIONS = [
  { value: "slack", label: "Slack", hint: "webhook URL" },
  { value: "discord", label: "Discord", hint: "webhook URL" },
  { value: "email", label: "Email", hint: "SMTP or API key" },
  { value: "system", label: "System", hint: "desktop notifications" },
];

const NOTIFICATION_EVENT_OPTIONS = [
  { value: "task.completed", label: "task.completed", hint: "when a task finishes successfully" },
  { value: "task.failed", label: "task.failed", hint: "when a task fails" },
  { value: "pr.created", label: "pr.created", hint: "when a pull request is created" },
  { value: "trigger.fired", label: "trigger.fired", hint: "when a trigger activates" },
  { value: "daily_digest", label: "daily_digest", hint: "daily summary report" },
  { value: "cost.warning", label: "cost.warning", hint: "when spending exceeds threshold" },
];

interface NotificationChannelConfig {
  name: string;
  provider: string;
  url?: string;
  apiKey?: string;
  events: string[];
}

function findConfigurationFilePath(): string | null {
  const globalConfigPath = join(KRAKEN_HOME, "kraken.yml");
  if (existsSync(globalConfigPath)) return globalConfigPath;
  return null;
}

function parseNotificationChannelsFromYaml(fileContents: string): NotificationChannelConfig[] {
  const parsedChannels: NotificationChannelConfig[] = [];
  const fileLines = fileContents.split("\n");

  let insideNotificationsSection = false;
  let insideChannelsSection = false;
  let currentChannel: Partial<NotificationChannelConfig> = {};
  let collectingEventsList = false;
  let collectedEvents: string[] = [];

  for (const currentLine of fileLines) {
    const trimmedLine = currentLine.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const lineIndentation = currentLine.length - currentLine.trimStart().length;

    if (lineIndentation === 0 && trimmedLine.startsWith("notifications:")) {
      insideNotificationsSection = true;
      continue;
    }

    if (insideNotificationsSection && lineIndentation === 0 && !trimmedLine.startsWith(" ")) {
      insideNotificationsSection = false;
      insideChannelsSection = false;
    }

    if (!insideNotificationsSection) continue;

    if (lineIndentation === 2 && trimmedLine.startsWith("channels:")) {
      insideChannelsSection = true;
      continue;
    }

    if (!insideChannelsSection) continue;

    if (lineIndentation === 4 && trimmedLine.startsWith("- name:")) {
      if (currentChannel.name) {
        if (collectingEventsList) {
          currentChannel.events = [...collectedEvents];
          collectingEventsList = false;
          collectedEvents = [];
        }
        parsedChannels.push(currentChannel as NotificationChannelConfig);
      }
      currentChannel = {
        name: trimmedLine.slice("- name:".length).trim().replace(/^["']|["']$/g, ""),
        events: [],
      };
      continue;
    }

    if (lineIndentation === 6 && currentChannel.name) {
      const colonPosition = trimmedLine.indexOf(":");
      if (colonPosition > 0) {
        const propertyKey = trimmedLine.slice(0, colonPosition).trim();
        const propertyValue = trimmedLine.slice(colonPosition + 1).trim().replace(/^["']|["']$/g, "");

        if (propertyKey === "events" && (!propertyValue || propertyValue === "[]")) {
          collectingEventsList = true;
          collectedEvents = [];
        } else if (propertyKey === "events") {
          currentChannel.events = propertyValue.split(",").map((eventName) => eventName.trim());
        } else {
          (currentChannel as Record<string, unknown>)[propertyKey] = propertyValue;
        }
      }
    }

    if (lineIndentation === 8 && trimmedLine.startsWith("- ") && collectingEventsList) {
      const eventValue = trimmedLine.slice(2).trim().replace(/^["']|["']$/g, "");
      collectedEvents.push(eventValue);
    }
  }

  if (currentChannel.name) {
    if (collectingEventsList) {
      currentChannel.events = [...collectedEvents];
    }
    parsedChannels.push(currentChannel as NotificationChannelConfig);
  }

  return parsedChannels;
}

function listNotificationChannels(): void {
  const configurationFilePath = findConfigurationFilePath();

  if (!configurationFilePath) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  const fileContents = readFileSync(configurationFilePath, "utf-8");
  const notificationChannels = parseNotificationChannelsFromYaml(fileContents);

  if (notificationChannels.length === 0) {
    console.log(`\n  No notification channels configured.`);
    console.log(`  Run ${colorize("kraken notification add", "cyan")} to add one.\n`);
    return;
  }

  console.log(`\n  ${bold("Notification Channels")}\n`);

  for (const channel of notificationChannels) {
    const providerLabel = NOTIFICATION_PROVIDER_OPTIONS.find(
      (providerOption) => providerOption.value === channel.provider,
    )?.label ?? channel.provider;

    console.log(`    ${colorize(channel.name, "cyan")}`);
    console.log(`      Provider: ${providerLabel}`);
    if (channel.url) {
      const maskedWebhookUrl = channel.url.startsWith("${")
        ? channel.url
        : channel.url.slice(0, 30) + "...";
      console.log(`      URL:      ${maskedWebhookUrl}`);
    }
    console.log(`      Events:   ${channel.events?.join(", ") || "none"}`);
    console.log();
  }
}

async function addNotificationChannelInteractively(): Promise<void> {
  const currentFileContents = readConfigFile();

  if (!currentFileContents) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  p.intro("Add notification channel");

  const channelName = await p.text({
    message: "Channel name",
    placeholder: "my-slack-alerts",
    validate: (inputValue = "") => {
      if (!inputValue.trim()) return "Name is required";
      if (!/^[a-zA-Z0-9_-]+$/.test(inputValue)) return "Use only letters, numbers, hyphens, and underscores";
    },
  });

  if (p.isCancel(channelName)) {
    p.cancel("Cancelled.");
    return;
  }

  const selectedProvider = await p.select({
    message: "Select notification provider",
    options: NOTIFICATION_PROVIDER_OPTIONS,
  });

  if (p.isCancel(selectedProvider)) {
    p.cancel("Cancelled.");
    return;
  }

  let webhookUrlValue: string | undefined;
  let apiKeyValue: string | undefined;

  if (selectedProvider === "slack" || selectedProvider === "discord") {
    const enteredWebhookUrl = await p.text({
      message: `Enter ${selectedProvider} webhook URL`,
      placeholder: "https://hooks.slack.com/services/...",
      validate: (inputValue = "") => {
        if (!inputValue.trim()) return "Webhook URL is required";
        if (!inputValue.startsWith("https://")) return "URL must start with https://";
      },
    });

    if (p.isCancel(enteredWebhookUrl)) {
      p.cancel("Cancelled.");
      return;
    }

    webhookUrlValue = enteredWebhookUrl;
  } else if (selectedProvider === "email") {
    const enteredApiKey = await p.text({
      message: "Enter email API key or SMTP credentials reference",
      placeholder: "${EMAIL_API_KEY}",
    });

    if (p.isCancel(enteredApiKey)) {
      p.cancel("Cancelled.");
      return;
    }

    apiKeyValue = enteredApiKey;
  }

  const selectedEvents = await p.multiselect({
    message: "Select events to receive notifications for",
    options: NOTIFICATION_EVENT_OPTIONS,
    required: true,
  });

  if (p.isCancel(selectedEvents)) {
    p.cancel("Cancelled.");
    return;
  }

  const notificationChannelItem: Record<string, unknown> = {
    name: channelName,
    provider: selectedProvider,
  };

  if (webhookUrlValue) {
    notificationChannelItem.url = webhookUrlValue;
  }

  if (apiKeyValue) {
    notificationChannelItem.apiKey = apiKeyValue;
  }

  notificationChannelItem.events = selectedEvents;

  const updatedFileContents = appendYamlArrayItem(
    currentFileContents,
    ["notifications", "channels"],
    notificationChannelItem,
  );

  writeConfigFile(updatedFileContents);

  success(`Added notification channel "${channelName}"`);
  p.outro("Channel added to kraken.yml.");
}

function removeNotificationChannel(channelNameToRemove: string): void {
  const currentFileContents = readConfigFile();

  if (!currentFileContents) {
    fail("no kraken.yml found. Run 'kraken init' to create one.");
    process.exit(1);
  }

  const existingChannels = parseNotificationChannelsFromYaml(currentFileContents);
  const channelExists = existingChannels.some(
    (channel) => channel.name === channelNameToRemove,
  );

  if (!channelExists) {
    fail(`notification channel "${channelNameToRemove}" not found`);

    if (existingChannels.length > 0) {
      console.log(`\n  Available channels:`);
      for (const channel of existingChannels) {
        console.log(`    - ${colorize(channel.name, "cyan")}`);
      }
    }
    console.log();
    process.exit(1);
  }

  const updatedFileContents = removeYamlArrayItemByName(
    currentFileContents,
    ["notifications", "channels"],
    channelNameToRemove,
  );

  writeConfigFile(updatedFileContents);
  success(`Removed notification channel "${channelNameToRemove}"`);
}

async function testNotificationChannel(channelNameToTest: string): Promise<void> {
  try {
    const grpcTransport = createGrpcTransport({
      baseUrl: process.env.KRAKEN_SCHEDULER_URL || "http://localhost:50051",
    });
    const daemonServiceClient = createClient(DaemonService, grpcTransport);
    const testNotificationResponse = await daemonServiceClient.testNotification({
      channelName: channelNameToTest,
    });
    if (testNotificationResponse.success) {
      success(testNotificationResponse.message);
    } else {
      fail(testNotificationResponse.message);
    }
  } catch {
    fail("Failed to connect to daemon. Is it running?");
  }
}

function printNotificationUsage(): void {
  console.log(`\n  ${bold("Usage:")}\n`);
  console.log(`    ${colorize("kraken notification", "cyan")} ${colorize("<subcommand> [options]", "dim")}\n`);
  console.log(`  ${bold("Subcommands:")}\n`);
  console.log(`    ${colorize("list", "cyan")}              List configured notification channels`);
  console.log(`    ${colorize("add", "cyan")}               Interactive wizard to add a channel`);
  console.log(`    ${colorize("remove", "cyan")} ${colorize("<name>", "dim")}     Remove a notification channel`);
  console.log(`    ${colorize("test", "cyan")} ${colorize("<name>", "dim")}       Send a test notification\n`);
}

export async function execute(args: string[]): Promise<void> {
  const subcommand = args.find((argument) => !argument.startsWith("-"));
  const remainingArguments = subcommand ? args.filter((argument) => argument !== subcommand) : args;

  switch (subcommand) {
    case "list":
      listNotificationChannels();
      break;
    case "add":
      await addNotificationChannelInteractively();
      break;
    case "remove": {
      const channelNameArgument = remainingArguments.find((argument) => !argument.startsWith("-"));
      if (!channelNameArgument) {
        fail("missing channel name. Usage: kraken notification remove <name>");
        process.exit(1);
      }
      removeNotificationChannel(channelNameArgument);
      break;
    }
    case "test": {
      const testChannelName = remainingArguments.find((argument) => !argument.startsWith("-"));
      if (!testChannelName) {
        fail("missing channel name. Usage: kraken notification test <name>");
        process.exit(1);
      }
      await testNotificationChannel(testChannelName);
      break;
    }
    default:
      if (subcommand) {
        fail(`Unknown notification subcommand: '${subcommand}'`);
      }
      printNotificationUsage();
      break;
  }
}
