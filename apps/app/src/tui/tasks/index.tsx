import { useState, useEffect, useCallback } from "react";
import { useTerminalDimensions, useKeyboard, useRenderer } from "@opentui/react";
import { useRoute } from "@/tui/_context/route.tsx";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useSdk } from "@/tui/_context/sdk.tsx";
import { getDaemon } from "@/daemon/client.ts";
import type { TaskDetails } from "@kraken/sdk";

const TASK_POLL_INTERVAL_MILLISECONDS = 5000;
const MAX_VISIBLE_TASKS = 20;

export const TaskDashboard = () => {
  const { theme } = useTheme();
  const route = useRoute();
  const sdk = useSdk();
  const terminalDimensions = useTerminalDimensions();
  const renderer = useRenderer();
  const [tasks, setTasks] = useState<TaskDetails[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);

  const fetchTasks = useCallback(async () => {
    try {
      const result = await getDaemon().tasks.list({
        status: statusFilter,
        limit: MAX_VISIBLE_TASKS,
      });
      setTasks(result);
    } catch {
      // daemon unreachable
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchTasks();
    const pollInterval = setInterval(fetchTasks, TASK_POLL_INTERVAL_MILLISECONDS);
    return () => clearInterval(pollInterval);
  }, [fetchTasks]);

  useEffect(() => {
    const unsubscribe = sdk.onEvent((eventType) => {
      if (eventType.startsWith("daemon.task.")) {
        fetchTasks();
      }
    });
    return unsubscribe;
  }, [fetchTasks]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "escape" || (keyEvent.ctrl && keyEvent.name === "c")) {
      route.goHome();
      return;
    }

    if (keyEvent.name === "up" && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    }
    if (keyEvent.name === "down" && selectedIndex < tasks.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    }

    if (keyEvent.name === "tab") {
      const filters = [undefined, "pending", "running", "completed", "failed"];
      const currentFilterIndex = filters.indexOf(statusFilter);
      const nextFilterIndex = (currentFilterIndex + 1) % filters.length;
      setStatusFilter(filters[nextFilterIndex]);
      setSelectedIndex(0);
    }

    if (keyEvent.ctrl && keyEvent.name === "c") {
      renderer.destroy();
      process.exit(0);
    }
  });

  const filterLabel = statusFilter ?? "all";

  return (
    <box
      flexDirection="column"
      width={terminalDimensions.width}
      height={terminalDimensions.height}
      backgroundColor={theme.background}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={1}>
        <text fg={theme.primary} content={` Tasks [${filterLabel}]`} />
        <box flexDirection="row" gap={2}>
          <text fg={theme.textMuted} content="tab filter" />
          <text fg={theme.textMuted} content="esc back" />
        </box>
      </box>

      <box flexDirection="column" flexGrow={1}>
        {tasks.length === 0 ? (
          <text fg={theme.textMuted} content="  No tasks found." />
        ) : (
          tasks.map((task, index) => (
            <TaskRow key={task.id} task={task} isSelected={index === selectedIndex} theme={theme} />
          ))
        )}
      </box>

      <box paddingTop={1} paddingBottom={1}>
        <text fg={theme.textMuted} content={`${tasks.length} tasks`} />
      </box>
    </box>
  );
};

function TaskRow({
  task,
  isSelected,
  theme,
}: {
  task: TaskDetails;
  isSelected: boolean;
  theme: Record<string, string>;
}) {
  const statusIcon = formatStatusIcon(task.status);
  const nameColor = isSelected ? theme.primary : theme.text;
  const backgroundColor = isSelected ? theme.backgroundHighlight : undefined;
  const taskName = task.name.length > 60 ? `${task.name.slice(0, 57)}...` : task.name;
  const timeDisplay = task.completed_at ?? task.started_at ?? task.created_at;

  return (
    <box flexDirection="row" gap={1} backgroundColor={backgroundColor} paddingLeft={1}>
      <text fg={theme.textMuted} content={statusIcon} />
      <text fg={nameColor} content={taskName} />
      <text fg={theme.textMuted} content={task.id.slice(0, 8)} />
      <text fg={theme.textMuted} content={timeDisplay} />
    </box>
  );
}

function formatStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "●";
    case "pending":
      return "○";
    case "cancelled":
      return "⊘";
    default:
      return "?";
  }
}
