import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { getDaemon } from "@/daemon/client.ts";
import { DaemonError, DaemonConnectionError } from "@kraken/sdk";

const DEFAULT_TASK_LIST_LIMIT = 10;
const TASK_OUTPUT_PREVIEW_LENGTH = 500;

export const taskListTool = defineTool({
  id: "task_list",
  description:
    "List background tasks from the Kraken daemon. Shows task ID, name, status, and timestamps. Use to check what tasks have been scheduled, are running, or have completed.",
  parameters: z.object({
    status: z
      .enum(["pending", "running", "completed", "failed", "cancelled"])
      .optional()
      .describe("Filter by status (optional, shows all if omitted)"),
    limit: z.number().optional().describe(`Max results (default: ${DEFAULT_TASK_LIST_LIMIT})`),
  }),
  async execute(args, _context) {
    try {
      const tasks = await getDaemon().tasks.list({
        status: args.status,
        limit: args.limit ?? DEFAULT_TASK_LIST_LIMIT,
      });

      if (tasks.length === 0) {
        const filterNote = args.status ? ` with status '${args.status}'` : "";
        return {
          title: "No tasks found",
          content: `No daemon tasks found${filterNote}.`,
        };
      }

      const formatted = tasks
        .map((task) => {
          const statusIcon = formatStatusIcon(task.status);
          const timeInfo = task.completed_at ?? task.started_at ?? task.created_at;
          return `${statusIcon} [${task.id.slice(0, 8)}] ${task.name}\n  Status: ${task.status} | Agent: ${task.agent} | ${timeInfo}`;
        })
        .join("\n\n");

      return {
        title: `${tasks.length} tasks`,
        content: formatted,
        metadata: { taskCount: tasks.length },
      };
    } catch (error) {
      return formatDaemonError("Task list failed", error);
    }
  },
});

export const taskGetTool = defineTool({
  id: "task_get",
  description:
    "Get detailed information about a specific daemon task including its output, logs, and status. Use after task_list to inspect a particular task's results.",
  parameters: z.object({
    task_id: z.string().describe("The task ID (full UUID or unique prefix from task_list)"),
  }),
  async execute(args, _context) {
    try {
      const task = await getDaemon().tasks.get(args.task_id);

      const parts: string[] = [];
      parts.push(`Task: ${task.name}`);
      parts.push(`ID: ${task.id}`);
      parts.push(`Status: ${task.status} | Agent: ${task.agent} | Priority: ${task.priority}`);
      parts.push(`Created: ${task.created_at}`);

      if (task.started_at) parts.push(`Started: ${task.started_at}`);
      if (task.completed_at) parts.push(`Completed: ${task.completed_at}`);

      if (task.description && task.description !== task.name) {
        parts.push(`\nDescription:\n${task.description}`);
      }

      if (task.output) {
        const preview =
          task.output.length > TASK_OUTPUT_PREVIEW_LENGTH
            ? `${task.output.slice(-TASK_OUTPUT_PREVIEW_LENGTH)}\n... (truncated, ${task.output.length} chars total)`
            : task.output;
        parts.push(`\nOutput:\n${preview}`);
      }

      if (task.error) {
        parts.push(`\nError: ${task.error}`);
      }

      return {
        title: `Task ${task.id.slice(0, 8)}: ${task.status}`,
        content: parts.join("\n"),
        metadata: { taskId: task.id, status: task.status },
      };
    } catch (error) {
      if (error instanceof DaemonError && error.status === 404) {
        return {
          title: "Task not found",
          content: `No task found with ID '${args.task_id}'.`,
        };
      }
      return formatDaemonError("Task get failed", error);
    }
  },
});

export const taskDeleteTool = defineTool({
  id: "task_delete",
  description:
    "Delete a pending or cancelled task from the Kraken daemon. Only tasks in 'pending' or 'cancelled' status can be deleted. Use task_list first to find the task ID.",
  parameters: z.object({
    task_id: z.string().describe("The task ID (full UUID or unique prefix from task_list)"),
  }),
  async execute(args, _context) {
    try {
      const result = await getDaemon().tasks.delete(args.task_id);
      return {
        title: "Task deleted",
        content: `Task ${result.task_id.slice(0, 8)} deleted successfully.`,
        metadata: { taskId: result.task_id },
      };
    } catch (error) {
      if (error instanceof DaemonError) {
        if (error.status === 404) {
          return {
            title: "Task not found",
            content: `No task found with ID '${args.task_id}'.`,
          };
        }
        if (error.status === 409) {
          return {
            title: "Cannot delete task",
            content: `Only pending or cancelled tasks can be deleted. The task may be running or completed.`,
          };
        }
      }
      return formatDaemonError("Task delete failed", error);
    }
  },
});

function formatStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "[ok]";
    case "failed":
      return "[!!]";
    case "running":
      return "[..]";
    case "pending":
      return "[--]";
    case "cancelled":
      return "[xx]";
    default:
      return "[??]";
  }
}

function formatDaemonError(title: string, error: unknown): { title: string; content: string } {
  if (error instanceof DaemonError) {
    return { title, content: `Daemon returned ${error.status}: ${error.body}` };
  }
  if (error instanceof DaemonConnectionError) {
    return { title, content: `Could not reach daemon at ${error.url}. Is it running?` };
  }
  return { title, content: `Unexpected error: ${error}` };
}
