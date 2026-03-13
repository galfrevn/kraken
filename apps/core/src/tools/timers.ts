import type { TimerManager, TimerTaskData } from "@/scheduling/timers.ts";
import type { Tool, ToolResult } from "@/tools/schema.ts";
import type { TaskPriority } from "@/queue/schema.ts";

const VALID_PRIORITIES = ["low", "medium", "high", "critical"];

export function createScheduleOnceTool(timerManager: TimerManager): Tool {
  return {
    definition: {
      name: "schedule_once",
      description: "Schedule a one-time task after a delay or at a specific time.",
      parameters: [
        {
          name: "title",
          type: "string",
          description:
            "Short, human-readable title for the task (e.g. 'Refactor auth module', 'Run test suite')",
          required: true,
        },
        {
          name: "description",
          type: "string",
          description:
            "Brief summary of the task's purpose and context. Shown in dashboards and lists.",
          required: true,
        },
        {
          name: "prompt",
          type: "string",
          description:
            "Detailed instructions for the agent to follow when executing this task. " +
            "Be specific: include file paths, expected outcomes, constraints, and step-by-step directions. " +
            "This is the full instruction set the agent will receive.",
          required: true,
        },
        {
          name: "delay",
          type: "string",
          description:
            "Relative delay (e.g. '30s', '5m', '2h', '1d'). Mutually exclusive with 'at'.",
          required: false,
        },
        {
          name: "at",
          type: "string",
          description:
            "Absolute ISO 8601 datetime (e.g. '2026-03-15T09:00:00'). Mutually exclusive with 'delay'.",
          required: false,
        },
        {
          name: "priority",
          type: "string",
          description: "Task priority: low, medium, high, critical (default: medium)",
          required: false,
        },
        {
          name: "tags",
          type: "string",
          description: "Comma-separated tags for categorization (e.g. 'refactor, auth, backend')",
          required: false,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const title = parameters["title"] as string;
      const description = parameters["description"] as string;
      const prompt = parameters["prompt"] as string;
      const delayStr = parameters["delay"] as string | undefined;
      const atStr = parameters["at"] as string | undefined;
      const priority = (parameters["priority"] as string) || "medium";
      const tagsRaw = (parameters["tags"] as string) || "";

      if (!title || !description || !prompt) {
        return { success: false, output: "", error: "title, description, and prompt are required" };
      }

      if (!delayStr && !atStr) {
        return { success: false, output: "", error: "either 'delay' or 'at' must be provided" };
      }

      if (delayStr && atStr) {
        return { success: false, output: "", error: "'delay' and 'at' are mutually exclusive" };
      }

      if (!VALID_PRIORITIES.includes(priority)) {
        return {
          success: false,
          output: "",
          error: `invalid priority: ${priority}. valid: ${VALID_PRIORITIES.join(", ")}`,
        };
      }

      const tags = tagsRaw
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);

      const taskData: TimerTaskData = {
        title,
        description,
        prompt,
        priority: priority as TaskPriority,
        tags,
      };

      let result: { id: string; scheduledAt: Date; delayMs: number } | { error: string };

      if (delayStr) {
        const delayMs = parseDelay(delayStr);
        if (delayMs === null) {
          return {
            success: false,
            output: "",
            error: `invalid delay format: "${delayStr}". use format like '30s', '5m', '2h', '1d'`,
          };
        }
        result = timerManager.scheduleAfter(taskData, delayMs);
      } else {
        const scheduledAt = new Date(atStr!);
        if (isNaN(scheduledAt.getTime())) {
          return {
            success: false,
            output: "",
            error: `invalid datetime: "${atStr}". use ISO 8601 format like '2026-03-15T09:00:00'`,
          };
        }
        result = timerManager.scheduleAt(taskData, scheduledAt);
      }

      if ("error" in result) {
        return { success: false, output: "", error: result.error };
      }

      const tagsLabel = tags.length > 0 ? `\n  tags: ${tags.join(", ")}` : "";

      return {
        success: true,
        output:
          `timer scheduled: ${title}\n` +
          `  id: ${result.id}\n` +
          `  priority: ${priority}\n` +
          `  fires at: ${result.scheduledAt.toISOString()}\n` +
          `  in: ${formatDuration(result.delayMs)}${tagsLabel}\n` +
          `  description: ${description}\n` +
          `  prompt: ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`,
      };
    },
  };
}

export function createListTimersTool(timerManager: TimerManager): Tool {
  return {
    definition: {
      name: "list_timers",
      description: "List all pending one-time timers.",
      parameters: [],
    },

    async execute(): Promise<ToolResult> {
      const timers = timerManager.list();

      if (timers.length === 0) {
        return { success: true, output: "no pending timers" };
      }

      const lines = timers.map((timer, index) => {
        const tagsLabel = timer.tags.length > 0 ? `\n   tags: ${timer.tags.join(", ")}` : "";
        const promptPreview =
          timer.prompt.length > 120 ? timer.prompt.slice(0, 120) + "..." : timer.prompt;

        return (
          `${index + 1}. ${timer.title}\n` +
          `   id: ${timer.id}\n` +
          `   priority: ${timer.priority}\n` +
          `   fires at: ${timer.scheduledAt.toISOString()}\n` +
          `   remaining: ${formatDuration(timer.remainingMs)}\n` +
          `   description: ${timer.description}\n` +
          `   prompt: ${promptPreview}${tagsLabel}`
        );
      });

      return {
        success: true,
        output: `${timers.length} pending timers:\n\n${lines.join("\n\n")}`,
      };
    },
  };
}

export function createCancelTimerTool(timerManager: TimerManager): Tool {
  return {
    definition: {
      name: "cancel_timer",
      description: "Cancel a pending timer by ID.",
      parameters: [
        {
          name: "timer_id",
          type: "string",
          description: "The timer ID to cancel (from list_timers)",
          required: true,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const timerId = parameters["timer_id"] as string;

      if (!timerId) {
        return { success: false, output: "", error: "timer_id is required" };
      }

      const cancelled = timerManager.cancel(timerId);

      if (!cancelled) {
        return { success: false, output: "", error: `timer not found: ${timerId}` };
      }

      return { success: true, output: `timer ${timerId} cancelled` };
    },
  };
}

function parseDelay(input: string): number | null {
  const match = input
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (!match) return null;

  const value = parseFloat(match[1] ?? "0");
  const unit = (match[2] ?? "s").toLowerCase();

  if (unit.startsWith("s")) return Math.round(value * 1000);
  if (unit.startsWith("m")) return Math.round(value * 60 * 1000);
  if (unit.startsWith("h")) return Math.round(value * 60 * 60 * 1000);
  if (unit.startsWith("d")) return Math.round(value * 24 * 60 * 60 * 1000);

  return null;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const remainingMinutes = Math.floor((seconds % 3600) / 60);
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(seconds / 86400);
  const remainingHours = Math.floor((seconds % 86400) / 3600);
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}
