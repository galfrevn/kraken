import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { getDaemon } from "@/daemon/client.ts";

export const channelSendTool = defineTool({
  id: "channel_send",
  description:
    "Send a message to a connected messaging channel (Telegram, Discord). Use when the user asks to be notified, messaged, or contacted through their phone/channel. If chat_id is not provided, the most recent active session for that channel is used automatically.",
  parameters: z.object({
    channel: z
      .string()
      .default("telegram")
      .describe("Channel type: 'telegram' or 'discord'. Defaults to 'telegram'."),
    message: z.string().describe("The message text to send (markdown format)"),
    chat_id: z
      .string()
      .optional()
      .describe("Target chat/channel ID. Leave empty to auto-resolve from active sessions."),
  }),
  async execute(args) {
    try {
      let chatId = args.chat_id;

      // Auto-resolve chat_id from active sessions if not provided
      if (!chatId) {
        const daemon = getDaemon();
        const response = await daemon.request<{
          sessions: Array<{ channelType: string; chatId: string; lastMessageAt: string }>;
        }>("GET", "/api/channels/sessions");

        const matching = response.sessions
          .filter((s) => s.channelType === args.channel)
          .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));

        if (matching.length === 0) {
          return {
            title: "No active sessions",
            content: `No active ${args.channel} sessions found. The user needs to send a message to the bot first.`,
          };
        }

        chatId = matching[0]!.chatId;
      }

      await getDaemon().sendToChannel({
        channel: args.channel,
        chatId,
        message: args.message,
      });

      return {
        title: `Message sent to ${args.channel}`,
        content: `Message delivered to ${args.channel} (chat: ${chatId})`,
      };
    } catch (error) {
      return {
        title: "Failed to send message",
        content: `Error: ${error}`,
      };
    }
  },
});
