import type { TaskQueueManager } from "@/queue/manager.ts";
import type { Tool, ToolResult } from "@/tools/schema.ts";

export function createTaskListTool(taskQueueManager: TaskQueueManager): Tool {
  return {
    definition: {
      name: "task_list",
      description:
        "List tasks in the agent's internal queue. Can filter by status: pending, running, completed, failed, cancelled. " +
        "Shows task ID, title, status, priority, description, and creation time.",
      parameters: [
        {
          name: "status",
          type: "string",
          description:
            "Filter by status (pending, running, completed, failed, cancelled). Shows all if omitted.",
          required: false,
        },
        {
          name: "limit",
          type: "number",
          description: "Maximum number of tasks to return (default: 20, max: 100)",
          required: false,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const statusFilter = parameters["status"] as string | undefined;
      const limit = Math.min(Math.max(Number(parameters["limit"]) || 20, 1), 100);

      const validStatuses = ["pending", "running", "completed", "failed", "cancelled"];
      if (statusFilter && !validStatuses.includes(statusFilter)) {
        return {
          success: false,
          output: "",
          error: `invalid status: ${statusFilter}. valid: ${validStatuses.join(", ")}`,
        };
      }

      try {
        const tasks = taskQueueManager.listTasks({
          status: statusFilter as
            | "pending"
            | "running"
            | "completed"
            | "failed"
            | "cancelled"
            | undefined,
          limit,
        });

        if (tasks.length === 0) {
          const label = statusFilter ? `no ${statusFilter} tasks` : "no tasks in queue";
          return { success: true, output: label };
        }

        const lines = tasks.map((task, index) => {
          const age = formatTimeAgo(task.createdAt);
          const params = task.parameters;
          const prompt = params["prompt"];
          const tags = params["tags"];

          let entry =
            `${index + 1}. [${task.status}] ${task.name}\n` +
            `   id: ${task.id}\n` +
            `   priority: ${task.priority} · trigger: ${task.triggerType} · created: ${age}`;

          if (task.description) {
            entry += `\n   description: ${task.description}`;
          }
          if (prompt) {
            const promptPreview = prompt.length > 150 ? prompt.slice(0, 150) + "..." : prompt;
            entry += `\n   prompt: ${promptPreview}`;
          }
          if (tags) {
            entry += `\n   tags: ${tags}`;
          }
          if (task.output) {
            const outputPreview =
              task.output.length > 100 ? task.output.slice(0, 100) + "..." : task.output;
            entry += `\n   output: ${outputPreview}`;
          }
          if (task.errorMessage) {
            entry += `\n   error: ${task.errorMessage}`;
          }

          return entry;
        });

        const header = statusFilter
          ? `${tasks.length} ${statusFilter} tasks:`
          : `${tasks.length} tasks:`;

        return { success: true, output: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: "", error: `failed to list tasks: ${message}` };
      }
    },
  };
}

export function createTaskSubmitTool(taskQueueManager: TaskQueueManager): Tool {
  return {
    definition: {
      name: "task_submit",
      description:
        "Submit a new task to the agent's internal queue for later execution. " +
        "Use this to queue work that should be done separately, such as follow-up actions, " +
        "background processing, or deferred operations. The 'prompt' field is critical — " +
        "it contains the full instructions the agent will follow when executing the task.",
      parameters: [
        {
          name: "title",
          type: "string",
          description:
            "Short, human-readable title for the task (e.g. 'Refactor auth module', 'Fix login bug')",
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
          name: "priority",
          type: "string",
          description: "Priority: low, medium, high, critical (default: medium)",
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
      const priority = (parameters["priority"] as string) || "medium";
      const tagsRaw = (parameters["tags"] as string) || "";

      if (!title || !description || !prompt) {
        return { success: false, output: "", error: "title, description, and prompt are required" };
      }

      const validPriorities = ["low", "medium", "high", "critical"];
      if (!validPriorities.includes(priority)) {
        return {
          success: false,
          output: "",
          error: `invalid priority: ${priority}. valid: ${validPriorities.join(", ")}`,
        };
      }

      const tags = tagsRaw
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);

      try {
        const task = taskQueueManager.submitTask({
          name: title,
          description,
          priority: priority as "low" | "medium" | "high" | "critical",
          parameters: {
            prompt,
            ...(tags.length > 0 ? { tags: tags.join(", ") } : {}),
          },
        });

        const tagsLabel = tags.length > 0 ? `\n  tags: ${tags.join(", ")}` : "";

        return {
          success: true,
          output:
            `task submitted:\n` +
            `  id: ${task.id}\n` +
            `  title: ${task.name}\n` +
            `  priority: ${task.priority}\n` +
            `  status: ${task.status}${tagsLabel}\n` +
            `  description: ${task.description}\n` +
            `  prompt: ${prompt.length > 200 ? prompt.slice(0, 200) + "..." : prompt}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: "", error: `failed to submit task: ${message}` };
      }
    },
  };
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
