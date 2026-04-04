import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { getDaemon } from "@/daemon/client.ts";
import { DaemonError, DaemonConnectionError } from "@kraken/sdk";

export const scheduleTool = defineTool({
  id: "schedule_task",
  description:
    "Create a background task on the Kraken daemon. Supports immediate execution, deferred execution (run_at), recurring intervals (repeat_interval_seconds), and cron schedules (cron_expression). Use this when the user asks you to run something in the background, schedule work for later, or set up recurring tasks.",
  parameters: z.object({
    prompt: z.string().describe("The task description / prompt for the agent to execute"),
    priority: z
      .number()
      .optional()
      .describe("Priority 0-10 (lower number = higher priority, default: 5)"),
    agent: z.string().optional().describe("Agent to use: 'build' (default) or 'plan'"),
    run_at: z
      .string()
      .optional()
      .describe(
        "ISO 8601 timestamp for deferred execution (e.g. '2025-03-26T09:00:00Z'). Omit for immediate.",
      ),
    cron_expression: z
      .string()
      .optional()
      .describe(
        "Cron expression for recurring schedule (e.g. '0 0 9 * * Mon-Fri' for weekdays at 9am). Uses 6-field format: sec min hour day month weekday.",
      ),
    repeat_interval_seconds: z
      .number()
      .optional()
      .describe("Repeat every N seconds after completion (e.g. 3600 for hourly, 86400 for daily)."),
  }),
  async execute(args, context) {
    try {
      const result = await getDaemon().schedule({
        prompt: args.prompt,
        priority: args.priority,
        agent: args.agent,
        workdir: process.cwd(),
        run_at: args.run_at,
        cron_expression: args.cron_expression,
        repeat_interval_seconds: args.repeat_interval_seconds,
        channel_type: context.channelType,
        channel_chat_id: context.channelChatId,
      });

      const schedulingDetails = formatSchedulingDetails(args);

      return {
        title: "Task scheduled",
        content: `Task ${result.task_id} created: ${args.prompt}${schedulingDetails}`,
        metadata: { taskId: result.task_id },
      };
    } catch (error) {
      if (error instanceof DaemonError) {
        return {
          title: "Schedule failed",
          content: `Daemon returned ${error.status}: ${error.body}`,
        };
      }
      if (error instanceof DaemonConnectionError) {
        return {
          title: "Schedule failed",
          content: `Could not reach daemon at ${error.url}. Is it running?`,
        };
      }
      return {
        title: "Schedule failed",
        content: `Unexpected error: ${error}`,
      };
    }
  },
});

function formatSchedulingDetails(args: {
  run_at?: string;
  cron_expression?: string;
  repeat_interval_seconds?: number;
}): string {
  const parts: string[] = [];
  if (args.run_at) parts.push(`Scheduled for: ${args.run_at}`);
  if (args.cron_expression) parts.push(`Cron: ${args.cron_expression}`);
  if (args.repeat_interval_seconds) parts.push(`Repeats every ${args.repeat_interval_seconds}s`);
  return parts.length > 0 ? `\n${parts.join(" | ")}` : "\nQueued for immediate execution";
}
