import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { Bus, Events } from "@/bus/index.ts";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
  updatedAt: number;
}

const sessionTodos = new Map<string, TodoItem[]>();

export function getTodos(sessionId: string): TodoItem[] {
  return sessionTodos.get(sessionId) ?? [];
}

export function clearTodos(sessionId: string): void {
  sessionTodos.delete(sessionId);
}

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "No tasks.";

  const completed = todos.filter((t) => t.status === "completed").length;
  const header = `Tasks: ${completed}/${todos.length} completed`;

  const lines = todos.map((t) => {
    const icon =
      t.status === "completed"
        ? "✓"
        : t.status === "in_progress"
          ? "◉"
          : t.status === "cancelled"
            ? "✗"
            : "○";
    const priorityTag = t.priority === "high" ? " [!]" : "";
    return `${icon} ${t.content}${priorityTag}`;
  });

  return `${header}\n${lines.join("\n")}`;
}

export const todoWriteTool = defineTool({
  id: "todowrite",
  description:
    "Create or update a task list to track progress on multi-step work. Use for complex tasks with 3+ steps. Each todo has an id, content, status (pending, in_progress, completed, cancelled), and priority (high, medium, low). Set merge=true to update specific items, merge=false to replace the entire list.",
  parameters: z.object({
    todos: z
      .array(
        z.object({
          id: z.string().describe("Unique identifier for this todo item"),
          content: z.string().describe("Description of the task"),
          status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
          priority: z.enum(["high", "medium", "low"]).describe("Task priority"),
        }),
      )
      .min(1),
    merge: z.boolean().describe("If true, merge with existing todos by id. If false, replace all."),
  }),
  execute(args, context) {
    const now = Date.now();
    let current = getTodos(context.sessionId);

    if (args.merge) {
      for (const incoming of args.todos) {
        const existingIndex = current.findIndex((t) => t.id === incoming.id);
        const item: TodoItem = { ...incoming, updatedAt: now };
        if (existingIndex >= 0) {
          current = [...current];
          current[existingIndex] = item;
        } else {
          current = [...current, item];
        }
      }
    } else {
      current = args.todos.map((t) => ({ ...t, updatedAt: now }));
    }

    sessionTodos.set(context.sessionId, current);

    Bus.publish(Events.Todo.Updated, {
      sessionId: context.sessionId,
      todos: current,
    });

    return Promise.resolve({
      title: "todowrite",
      content: formatTodoList(current),
    });
  },
});
