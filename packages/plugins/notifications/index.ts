import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult, PluginContext } from "@kraken/sdk";

// ---------------------------------------------------------------------------
// Config state
// ---------------------------------------------------------------------------

let slackWebhookUrl: string | undefined;
let discordWebhookUrl: string | undefined;
let telegramBotToken: string | undefined;
let telegramChatId: string | undefined;

type Platform = "slack" | "discord" | "telegram";

function getConfiguredPlatforms(): Platform[] {
  const platforms: Platform[] = [];
  if (slackWebhookUrl) platforms.push("slack");
  if (discordWebhookUrl) platforms.push("discord");
  if (telegramBotToken && telegramChatId) platforms.push("telegram");
  return platforms;
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

async function sendSlack(message: string): Promise<void> {
  const response = await fetch(slackWebhookUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
}

async function sendDiscord(message: string): Promise<void> {
  const truncated = message.slice(0, 2000);
  const response = await fetch(discordWebhookUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: truncated }),
  });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
}

async function sendTelegram(message: string): Promise<void> {
  const truncated = message.slice(0, 4096);
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: truncated,
      parse_mode: "Markdown",
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
}

const senders: Record<Platform, (message: string) => Promise<void>> = {
  slack: sendSlack,
  discord: sendDiscord,
  telegram: sendTelegram,
};

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const notifySendTool: Tool = {
  definition: {
    name: "notify_send",
    description:
      "Send a notification message to configured platforms (Slack, Discord, Telegram). Sends in parallel to all configured platforms unless filtered.",
    requiresConfirmation: true,
    parameters: [
      {
        name: "message",
        type: "string",
        description: "Text message to send.",
        required: true,
      },
      {
        name: "platforms",
        type: "string",
        description:
          'Comma-separated filter: "slack,discord,telegram". Default: all configured platforms.',
        required: false,
      },
    ],
  },

  async execute(parameters): Promise<ToolResult> {
    const message = parameters["message"] as string;
    if (!message) return { success: false, output: "message is required" };

    const configured = getConfiguredPlatforms();
    if (configured.length === 0) {
      return {
        success: false,
        output:
          "No notification platforms configured. Set webhook URLs or Telegram credentials in plugin config or environment variables.",
      };
    }

    const platformsRaw = parameters["platforms"] as string | undefined;
    let targets: Platform[];
    if (platformsRaw) {
      targets = platformsRaw
        .split(",")
        .map((p) => p.trim().toLowerCase() as Platform)
        .filter((p) => configured.includes(p));
      if (targets.length === 0) {
        return {
          success: false,
          output: `None of the requested platforms (${platformsRaw}) are configured. Configured: ${configured.join(", ")}`,
        };
      }
    } else {
      targets = configured;
    }

    const results = await Promise.allSettled(
      targets.map(async (platform) => {
        await senders[platform](message);
        return platform;
      }),
    );

    const sent: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const platform = targets[i]!;
      if (result.status === "fulfilled") {
        sent.push(platform);
      } else {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        failed.push(`${platform} (${reason})`);
      }
    }

    const parts: string[] = [];
    if (sent.length > 0) parts.push(`Sent to: ${sent.join(", ")}`);
    if (failed.length > 0) parts.push(`Failed: ${failed.join(", ")}`);

    return {
      success: failed.length === 0,
      output: parts.join(". "),
    };
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default definePlugin({
  name: "notifications",
  version: "0.1.0",
  description:
    "Send notifications to Slack, Discord, and Telegram. All platforms are optional — configure the ones you use.",
  author: "kraken",

  toolDisplayNames: {
    notify_send: "Send Notification",
  },

  configSchema: {
    slack_webhook_url: {
      type: "string",
      description: "Slack webhook URL",
      required: false,
      envVar: "SLACK_WEBHOOK_URL",
    },
    discord_webhook_url: {
      type: "string",
      description: "Discord webhook URL",
      required: false,
      envVar: "DISCORD_WEBHOOK_URL",
    },
    telegram_bot_token: {
      type: "string",
      description: "Telegram bot token",
      required: false,
      envVar: "TELEGRAM_BOT_TOKEN",
    },
    telegram_chat_id: {
      type: "string",
      description: "Telegram chat ID",
      required: false,
      envVar: "TELEGRAM_CHAT_ID",
    },
  },

  tools: [notifySendTool],

  promptExtension:
    "You have the 'notify_send' tool from the notifications plugin.\n" +
    "Use it to send messages to Slack, Discord, or Telegram.\n" +
    "The user has configured their preferred platforms — just provide a message and it sends to all of them.\n" +
    'Optionally filter with the platforms parameter (e.g., "slack,telegram").\n\n' +
    "First-time setup: Ask the user which platforms they want to use, then save each with plugin_manager " +
    '(action="configure", plugin_name="notifications", field="<field>", value="<value>").\n' +
    "Available fields: slack_webhook_url, discord_webhook_url, telegram_bot_token, telegram_chat_id. " +
    "All are optional — only configure the platforms the user wants.",

  activate: async (context: PluginContext) => {
    slackWebhookUrl = (context.config.slack_webhook_url as string) || Bun.env.SLACK_WEBHOOK_URL;
    discordWebhookUrl =
      (context.config.discord_webhook_url as string) || Bun.env.DISCORD_WEBHOOK_URL;
    telegramBotToken = (context.config.telegram_bot_token as string) || Bun.env.TELEGRAM_BOT_TOKEN;
    telegramChatId = (context.config.telegram_chat_id as string) || Bun.env.TELEGRAM_CHAT_ID;

    const configured = getConfiguredPlatforms();
    console.log(
      `[notifications] activated — platforms: ${configured.length > 0 ? configured.join(", ") : "none"}`,
    );
  },

  deactivate: async () => {
    slackWebhookUrl = undefined;
    discordWebhookUrl = undefined;
    telegramBotToken = undefined;
    telegramChatId = undefined;
    console.log("[notifications] deactivated");
  },
});
