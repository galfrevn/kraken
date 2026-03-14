import type { SchedulerClient } from "@/clients/scheduler.ts";
import type { Tool, ToolResult } from "@/tools/schema.ts";

function normalizeToSixFieldCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length === 5) {
    return `0 ${expression.trim()}`;
  }
  return expression.trim();
}

export function createScheduleCronTool(schedulerClient: SchedulerClient): Tool {
  return {
    definition: {
      name: "schedule_cron",
      description: "Schedule a recurring cron job.",
      parameters: [
        {
          name: "name",
          type: "string",
          description: "Descriptive name for the cron job (e.g. 'daily-review', 'hourly-sync')",
          required: true,
        },
        {
          name: "expression",
          type: "string",
          description: "Cron expression (e.g. '0 9 * * *', '*/15 * * * *')",
          required: true,
        },
        {
          name: "task",
          type: "string",
          description:
            "Task template name that runs when triggered (e.g. 'review-prs', 'run-tests')",
          required: true,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const name = parameters["name"] as string;
      const expression = parameters["expression"] as string;
      const task = parameters["task"] as string;

      if (!name || !expression || !task) {
        return { success: false, output: "", error: "name, expression, and task are all required" };
      }

      const normalizedExpression = normalizeToSixFieldCron(expression);

      try {
        const response = await schedulerClient.registerCron({
          name,
          cronExpression: normalizedExpression,
          taskTemplate: task,
          parameters: {},
        });

        return {
          success: true,
          output:
            `cron job scheduled: ${name}\n` +
            `  id: ${response.cronId}\n` +
            `  expression: ${normalizedExpression}\n` +
            `  task: ${task}\n` +
            `  next run: ${response.nextRun}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: "", error: `failed to schedule cron: ${message}` };
      }
    },
  };
}

export function createListSchedulesTool(schedulerClient: SchedulerClient): Tool {
  return {
    definition: {
      name: "list_schedules",
      description: "List all scheduled cron jobs.",
      parameters: [],
    },

    async execute(): Promise<ToolResult> {
      try {
        const response = await schedulerClient.listCrons({});
        const crons = response.crons;

        if (crons.length === 0) {
          return { success: true, output: "no scheduled cron jobs" };
        }

        const lines = crons.map((cron, index) => {
          const enabledLabel = cron.enabled ? "enabled" : "disabled";
          return (
            `${index + 1}. ${cron.name} [${enabledLabel}]\n` +
            `   id: ${cron.cronId}\n` +
            `   expression: ${cron.cronExpression}\n` +
            `   task: ${cron.taskTemplate}\n` +
            `   next run: ${cron.nextRun}`
          );
        });

        return {
          success: true,
          output: `${crons.length} scheduled cron jobs:\n\n${lines.join("\n\n")}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: "", error: `failed to list schedules: ${message}` };
      }
    },
  };
}

export function createDeleteScheduleTool(schedulerClient: SchedulerClient): Tool {
  return {
    definition: {
      name: "delete_schedule",
      description: "Delete a scheduled cron job by ID.",
      parameters: [
        {
          name: "cron_id",
          type: "string",
          description: "The cron job ID to delete (from list_schedules)",
          required: true,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const cronId = parameters["cron_id"] as string;

      if (!cronId) {
        return { success: false, output: "", error: "cron_id is required" };
      }

      try {
        await schedulerClient.unregisterCron({ cronId });
        return { success: true, output: `cron job ${cronId} deleted` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: "", error: `failed to delete schedule: ${message}` };
      }
    },
  };
}

export function createListWatchersTool(schedulerClient: SchedulerClient): Tool {
  return {
    definition: {
      name: "list_watchers",
      description: "List all registered file watchers.",
      parameters: [],
    },

    async execute(): Promise<ToolResult> {
      try {
        const response = await schedulerClient.listWatchers({});
        const watchers = response.watchers;

        if (watchers.length === 0) {
          return { success: true, output: "no registered file watchers" };
        }

        const lines = watchers.map((w, index) => {
          return (
            `${index + 1}. ${w.name}\n` +
            `   id: ${w.watcherId}\n` +
            `   paths: ${w.paths.join(", ")}\n` +
            `   debounce: ${w.debounceMs}ms`
          );
        });

        return {
          success: true,
          output: `${watchers.length} registered file watchers:\n\n${lines.join("\n\n")}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: "", error: `failed to list watchers: ${message}` };
      }
    },
  };
}

export function createScheduleWatcherTool(schedulerClient: SchedulerClient): Tool {
  return {
    definition: {
      name: "schedule_watcher",
      description: "Register a file watcher on directories.",
      parameters: [
        {
          name: "name",
          type: "string",
          description: "Descriptive name for the watcher (e.g. 'src-watcher')",
          required: true,
        },
        {
          name: "paths",
          type: "string",
          description: "Comma-separated list of directories to watch (e.g. './src,./lib')",
          required: true,
        },
        {
          name: "debounce",
          type: "number",
          description: "Debounce interval in milliseconds (default: 500)",
          required: false,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const name = parameters["name"] as string;
      const pathsString = parameters["paths"] as string;
      const debounceMs = Number(parameters["debounce"]) || 500;

      if (!name || !pathsString) {
        return { success: false, output: "", error: "name and paths are required" };
      }

      const paths = pathsString
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      if (paths.length === 0) {
        return { success: false, output: "", error: "at least one path is required" };
      }

      try {
        const response = await schedulerClient.registerWatcher({
          name,
          paths,
          ignorePatterns: ["node_modules", ".git", "target", "dist", ".turbo", "__pycache__"],
          debounceMs,
        });

        return {
          success: true,
          output:
            `file watcher registered: ${name}\n` +
            `  id: ${response.watcherId}\n` +
            `  paths: ${paths.join(", ")}\n` +
            `  debounce: ${debounceMs}ms`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: "", error: `failed to register watcher: ${message}` };
      }
    },
  };
}

export function createDeleteWatcherTool(schedulerClient: SchedulerClient): Tool {
  return {
    definition: {
      name: "delete_watcher",
      description: "Delete a file watcher by ID.",
      parameters: [
        {
          name: "watcher_id",
          type: "string",
          description: "The watcher ID to delete",
          required: true,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const watcherId = parameters["watcher_id"] as string;

      if (!watcherId) {
        return { success: false, output: "", error: "watcher_id is required" };
      }

      try {
        await schedulerClient.unregisterWatcher({ watcherId });
        return { success: true, output: `watcher ${watcherId} deleted` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: "", error: `failed to delete watcher: ${message}` };
      }
    },
  };
}
