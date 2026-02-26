import { useState, useEffect, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { COLORS, STATUS_ICONS, STATUS_COLORS } from "@/theme.ts";
import type { TuiStore } from "@/store.ts";
import type { TaskRow } from "@core/storage/database.ts";

const REFRESH_INTERVAL_MILLISECONDS = 2_000;

interface TasksViewProps {
  store: TuiStore;
  focused: boolean;
}

export function TasksView({ store, focused }: TasksViewProps) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailMode, setDetailMode] = useState(false);

  const refresh = useCallback(() => {
    setTasks(store.fetchRecentTasks(50));
  }, [store]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);
    return () => clearInterval(interval);
  }, [refresh]);

  useKeyboard((key) => {
    if (!focused) return;

    if (detailMode) {
      if (key.name === "escape" || key.name === "q") {
        setDetailMode(false);
      }
      return;
    }

    if (key.name === "j" || key.name === "down") {
      setSelectedIndex((previous) => Math.min(previous + 1, tasks.length - 1));
    }
    if (key.name === "k" || key.name === "up") {
      setSelectedIndex((previous) => Math.max(previous - 1, 0));
    }
    if (key.name === "return") {
      if (tasks.length > 0) setDetailMode(true);
    }
  });

  const selectedTask = tasks[selectedIndex];

  if (detailMode && selectedTask) {
    return <TaskDetail store={store} task={selectedTask} />;
  }

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box flexDirection="row" paddingBottom={1}>
        <text fg={COLORS.textSecondary}>
          {tasks.length + " tasks  ·  j/k navigate  ·  enter detail  ·  esc back"}
        </text>
      </box>

      <scrollbox flexGrow={1} width="100%">
        {tasks.map((task, index) => {
          const isSelected = index === selectedIndex;
          const icon = STATUS_ICONS[task.status] ?? "?";
          const statusColor = STATUS_COLORS[task.status] ?? COLORS.textMuted;
          const reviewTag =
            task.approval_policy === "review_required" &&
            task.status === "pending"
              ? " [review]"
              : "";

          const descriptionPreview = task.description
            ? task.description.length > 50
              ? "  " + task.description.slice(0, 50) + "..."
              : "  " + task.description
            : "";

          return (
            <box
              key={task.id}
              flexDirection="row"
              width="100%"
              backgroundColor={isSelected ? COLORS.surface : undefined}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={statusColor}>{icon + " "}</text>
              <text fg={isSelected ? COLORS.text : COLORS.textSecondary}>
                {task.name + reviewTag}
              </text>
              <text fg={COLORS.textMuted}>{descriptionPreview}</text>
              <box flexGrow={1} />
              <text fg={COLORS.textMuted}>
                {task.priority + "  " + task.trigger_type + "  " + task.id.slice(0, 8)}
              </text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}

interface TaskDetailProps {
  store: TuiStore;
  task: TaskRow;
}

function TaskDetail({ store, task: initialTask }: TaskDetailProps) {
  const [task, setTask] = useState(initialTask);
  const [logs, setLogs] = useState(store.fetchTaskLogs(initialTask.id));

  useEffect(() => {
    const refresh = () => {
      const tasks = store.fetchRecentTasks(100);
      const updated = tasks.find((t) => t.id === initialTask.id);
      if (updated) setTask(updated);
      setLogs(store.fetchTaskLogs(initialTask.id));
    };

    const interval = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);
    return () => clearInterval(interval);
  }, [store, initialTask.id]);

  const statusColor = STATUS_COLORS[task.status] ?? COLORS.textMuted;
  const statusIcon = STATUS_ICONS[task.status] ?? "?";

  let parsedParameters: Record<string, string> = {};
  try {
    parsedParameters = JSON.parse(task.parameters);
  } catch {
    // noop
  }

  const shortId = task.id.slice(0, 8);

  const descriptionPreview = task.description
    ? task.description.length > 80
      ? task.description.slice(0, 80) + "..."
      : task.description
    : "";

  const promptPreview = parsedParameters.prompt
    ? parsedParameters.prompt.length > 120
      ? parsedParameters.prompt.slice(0, 120) + "..."
      : parsedParameters.prompt
    : "";

  const fields: Array<{ label: string; value: string; color?: string }> = [
    { label: "id", value: shortId },
    { label: "status", value: task.status, color: statusColor },
    { label: "trigger", value: task.trigger_type },
    { label: "policy", value: task.approval_policy },
    { label: "created", value: task.created_at },
  ];

  if (task.started_at) fields.push({ label: "started", value: task.started_at });
  if (task.completed_at) fields.push({ label: "ended", value: task.completed_at });
  if (parsedParameters.tags) fields.push({ label: "tags", value: parsedParameters.tags });

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box paddingBottom={1} width="100%">
        <text fg={COLORS.textSecondary}>{"esc back"}</text>
      </box>

      <scrollbox flexGrow={1} width="100%">
        <box flexDirection="column" width="100%">
          <box backgroundColor={COLORS.card} flexDirection="column" padding={1} width="100%">
            <box width="100%">
              <text fg={COLORS.text}>{statusIcon + " " + task.name}</text>
            </box>
            <box width="100%" height={1} />
            {fields.map((field) => (
              <box flexDirection="row" width="100%">
                <text fg={COLORS.textMuted}>{"  " + field.label.padEnd(10)}</text>
                <text fg={field.color ?? COLORS.textSecondary}>{field.value}</text>
              </box>
            ))}
          </box>

          {descriptionPreview ? (
            <box backgroundColor={COLORS.card} flexDirection="column" padding={1} width="100%" marginTop={1}>
              <box width="100%">
                <text fg={COLORS.textMuted}>{"description"}</text>
              </box>
              <box width="100%">
                <text fg={COLORS.text}>{"  " + descriptionPreview}</text>
              </box>
            </box>
          ) : null}

          {promptPreview ? (
            <box backgroundColor={COLORS.card} flexDirection="column" padding={1} width="100%" marginTop={1}>
              <box width="100%">
                <text fg={COLORS.textMuted}>{"prompt"}</text>
              </box>
              <box width="100%">
                <text fg={COLORS.text}>{"  " + promptPreview}</text>
              </box>
            </box>
          ) : null}

          {task.output ? (
            <box backgroundColor={COLORS.card} flexDirection="column" padding={1} width="100%" marginTop={1}>
              <box width="100%">
                <text fg={COLORS.textMuted}>{"output"}</text>
              </box>
              <box width="100%">
                <text fg={COLORS.text}>{"  " + task.output}</text>
              </box>
            </box>
          ) : null}

          {task.error_message ? (
            <box backgroundColor={COLORS.card} flexDirection="column" padding={1} width="100%" marginTop={1}>
              <box width="100%">
                <text fg={COLORS.red}>{"error"}</text>
              </box>
              <box width="100%">
                <text fg={COLORS.text}>{"  " + task.error_message}</text>
              </box>
            </box>
          ) : null}

          {logs.length > 0 ? (
            <box backgroundColor={COLORS.card} flexDirection="column" padding={1} width="100%" marginTop={1}>
              <box width="100%">
                <text fg={COLORS.textMuted}>{"logs (" + logs.length + ")"}</text>
              </box>
              {logs.map((log, index) => {
                const levelColor =
                  log.level === "error"
                    ? COLORS.red
                    : log.level === "warn"
                      ? COLORS.yellow
                      : COLORS.textSecondary;
                return (
                  <box key={index} width="100%">
                    <text fg={levelColor}>
                      {"  " + log.created_at + " [" + log.level + "] " + log.message}
                    </text>
                  </box>
                );
              })}
            </box>
          ) : null}
        </box>
      </scrollbox>
    </box>
  );
}
