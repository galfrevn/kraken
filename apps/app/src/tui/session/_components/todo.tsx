import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/tui/_context/theme.tsx";

interface TodoDisplayItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

interface TodoDisplayProperties {
  todos: TodoDisplayItem[];
  agentColor?: string;
}

export const TodoDisplay = ({ todos, agentColor }: TodoDisplayProperties) => {
  const { theme } = useTheme();

  if (todos.length === 0) return null;

  const allCompleted = todos.every((t) => t.status === "completed");
  if (allCompleted) return null;

  const activeColor = agentColor ?? theme.warning;

  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD} content="Todo" />

      {todos.map((todo) => {
        const priorityMark = todo.priority === "high" ? " !" : "";

        if (todo.status === "completed") {
          return (
            <box key={todo.id} flexDirection="row" gap={0}>
              <text fg={theme.textMuted} content="[✓] " />
              <text fg={theme.textMuted} content={todo.content} />
            </box>
          );
        }

        if (todo.status === "cancelled") {
          return (
            <box key={todo.id} flexDirection="row" gap={0}>
              <text fg={theme.textMuted} content="[✗] " />
              <text fg={theme.textMuted} content={todo.content} />
            </box>
          );
        }

        const icon = todo.status === "in_progress" ? "•" : " ";
        const fg = todo.status === "in_progress" ? activeColor : theme.textMuted;

        return (
          <box key={todo.id} flexDirection="row" gap={0}>
            <text fg={fg} content={`[${icon}] `} />
            <text fg={fg} content={`${todo.content}${priorityMark}`} />
          </box>
        );
      })}
    </box>
  );
};
