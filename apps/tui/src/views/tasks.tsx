import { useState, useEffect, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { COLORS, STATUS_ICONS, STATUS_COLORS } from "@/theme.ts";
import type { TuiStore } from "@/store.ts";
import type { DaemonStore } from "@/daemon-store.ts";
import type { TaskRow } from "@core/storage/database.ts";

const REFRESH_INTERVAL_MILLISECONDS = 2_000;

interface DisplayableTask {
  taskId: string;
  taskName: string;
  taskDescription: string;
  taskStatus: string;
  taskPriority: string;
  triggerType: string;
  approvalPolicy: string;
  parametersJson: string;
  taskOutput: string;
  errorMessage: string;
  createdAtDisplay: string;
  startedAtDisplay: string | null;
  completedAtDisplay: string | null;
  workerPid: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedCostUsd: number | null;
}

interface DisplayableLogEntry {
  level: string;
  message: string;
  createdAtDisplay: string;
}

function convertTaskRowToDisplayableTask(taskRow: TaskRow): DisplayableTask {
  return {
    taskId: taskRow.id,
    taskName: taskRow.name,
    taskDescription: taskRow.description,
    taskStatus: taskRow.status,
    taskPriority: taskRow.priority,
    triggerType: taskRow.trigger_type,
    approvalPolicy: taskRow.approval_policy,
    parametersJson: taskRow.parameters,
    taskOutput: taskRow.output,
    errorMessage: taskRow.error_message,
    createdAtDisplay: taskRow.created_at,
    startedAtDisplay: taskRow.started_at,
    completedAtDisplay: taskRow.completed_at,
    workerPid: null,
    promptTokens: null,
    completionTokens: null,
    estimatedCostUsd: null,
  };
}

function formatDateForDisplay(date: Date | undefined): string | null {
  if (!date) return null;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

interface TasksViewProps {
  store: TuiStore;
  daemonStore?: DaemonStore | null;
  focused: boolean;
}

export function TasksView({ store, daemonStore, focused }: TasksViewProps) {
  const [displayableTasks, setDisplayableTasks] = useState<DisplayableTask[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailMode, setDetailMode] = useState(false);

  const isDaemonModeActive = !!daemonStore;

  const refresh = useCallback(() => {
    if (daemonStore) {
      daemonStore.fetchRecentTasks(50).then((daemonTaskInfoList) => {
        const mappedTasks: DisplayableTask[] = daemonTaskInfoList.map((daemonTaskInfo) => ({
          taskId: daemonTaskInfo.taskId,
          taskName: daemonTaskInfo.taskName,
          taskDescription: "",
          taskStatus: daemonTaskInfo.taskStatus,
          taskPriority: String(daemonTaskInfo.taskPriority),
          triggerType: daemonTaskInfo.triggerType,
          approvalPolicy: "",
          parametersJson: "{}",
          taskOutput: daemonTaskInfo.taskOutput,
          errorMessage: daemonTaskInfo.errorMessage,
          createdAtDisplay: formatDateForDisplay(daemonTaskInfo.createdAt) ?? "",
          startedAtDisplay: formatDateForDisplay(daemonTaskInfo.startedAt),
          completedAtDisplay: formatDateForDisplay(daemonTaskInfo.completedAt),
          workerPid: daemonTaskInfo.workerPid || null,
          promptTokens: daemonTaskInfo.promptTokens || null,
          completionTokens: daemonTaskInfo.completionTokens || null,
          estimatedCostUsd: daemonTaskInfo.estimatedCostUsd || null,
        }));
        setDisplayableTasks(mappedTasks);
      });
    } else {
      const localTasks = store.fetchRecentTasks(50);
      setDisplayableTasks(localTasks.map(convertTaskRowToDisplayableTask));
    }
  }, [store, daemonStore]);

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
      setSelectedIndex((previous) => Math.min(previous + 1, displayableTasks.length - 1));
    }
    if (key.name === "k" || key.name === "up") {
      setSelectedIndex((previous) => Math.max(previous - 1, 0));
    }
    if (key.name === "return") {
      if (displayableTasks.length > 0) setDetailMode(true);
    }
    if (key.name === "c" && isDaemonModeActive && daemonStore) {
      const taskToCancel = displayableTasks[selectedIndex];
      if (taskToCancel) {
        daemonStore.cancelTask(taskToCancel.taskId);
      }
    }
  });

  const selectedTask = displayableTasks[selectedIndex];

  if (detailMode && selectedTask) {
    return (
      <TaskDetail
        store={store}
        daemonStore={daemonStore}
        displayableTask={selectedTask}
        isDaemonModeActive={isDaemonModeActive}
      />
    );
  }

  const navigationHint = isDaemonModeActive
    ? displayableTasks.length + " tasks  ·  j/k navigate  ·  enter detail  ·  c cancel  ·  esc back"
    : displayableTasks.length + " tasks  ·  j/k navigate  ·  enter detail  ·  esc back";

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box flexDirection="row" paddingBottom={1}>
        <text fg={COLORS.textSecondary}>{navigationHint}</text>
      </box>

      <scrollbox flexGrow={1} width="100%">
        {displayableTasks.map((task, index) => {
          const isSelected = index === selectedIndex;
          const statusIcon = STATUS_ICONS[task.taskStatus] ?? "?";
          const statusColor = STATUS_COLORS[task.taskStatus] ?? COLORS.textMuted;
          const reviewTag =
            task.approvalPolicy === "review_required" && task.taskStatus === "pending"
              ? " [review]"
              : "";

          const descriptionPreview = task.taskDescription
            ? task.taskDescription.length > 50
              ? "  " + task.taskDescription.slice(0, 50) + "..."
              : "  " + task.taskDescription
            : "";

          return (
            <box
              key={task.taskId}
              flexDirection="row"
              width="100%"
              backgroundColor={isSelected ? COLORS.surface : undefined}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={statusColor}>{statusIcon + " "}</text>
              <text fg={isSelected ? COLORS.text : COLORS.textSecondary}>
                {task.taskName + reviewTag}
              </text>
              <text fg={COLORS.textMuted}>{descriptionPreview}</text>
              <box flexGrow={1} />
              <text fg={COLORS.textMuted}>
                {task.taskPriority + "  " + task.triggerType + "  " + task.taskId.slice(0, 8)}
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
  daemonStore?: DaemonStore | null;
  displayableTask: DisplayableTask;
  isDaemonModeActive: boolean;
}

function TaskDetail({
  store,
  daemonStore,
  displayableTask: initialDisplayableTask,
  isDaemonModeActive,
}: TaskDetailProps) {
  const [displayableTask, setDisplayableTask] = useState(initialDisplayableTask);
  const [logEntries, setLogEntries] = useState<DisplayableLogEntry[]>([]);

  useEffect(() => {
    const fetchInitialLogs = () => {
      if (daemonStore) {
        daemonStore.fetchTaskLogs(initialDisplayableTask.taskId).then((daemonLogEntries) => {
          setLogEntries(
            daemonLogEntries.map((daemonLogEntry) => ({
              level: daemonLogEntry.level,
              message: daemonLogEntry.message,
              createdAtDisplay: formatDateForDisplay(daemonLogEntry.timestamp) ?? "",
            })),
          );
        });
      } else {
        const localLogRows = store.fetchTaskLogs(initialDisplayableTask.taskId);
        setLogEntries(
          localLogRows.map((localLogRow) => ({
            level: localLogRow.level,
            message: localLogRow.message,
            createdAtDisplay: localLogRow.created_at,
          })),
        );
      }
    };

    fetchInitialLogs();

    const refresh = () => {
      if (daemonStore) {
        daemonStore.fetchRecentTasks(100).then((daemonTaskInfoList) => {
          const updatedDaemonTask = daemonTaskInfoList.find(
            (daemonTaskInfo) => daemonTaskInfo.taskId === initialDisplayableTask.taskId,
          );
          if (updatedDaemonTask) {
            setDisplayableTask({
              taskId: updatedDaemonTask.taskId,
              taskName: updatedDaemonTask.taskName,
              taskDescription: "",
              taskStatus: updatedDaemonTask.taskStatus,
              taskPriority: String(updatedDaemonTask.taskPriority),
              triggerType: updatedDaemonTask.triggerType,
              approvalPolicy: "",
              parametersJson: "{}",
              taskOutput: updatedDaemonTask.taskOutput,
              errorMessage: updatedDaemonTask.errorMessage,
              createdAtDisplay: formatDateForDisplay(updatedDaemonTask.createdAt) ?? "",
              startedAtDisplay: formatDateForDisplay(updatedDaemonTask.startedAt),
              completedAtDisplay: formatDateForDisplay(updatedDaemonTask.completedAt),
              workerPid: updatedDaemonTask.workerPid || null,
              promptTokens: updatedDaemonTask.promptTokens || null,
              completionTokens: updatedDaemonTask.completionTokens || null,
              estimatedCostUsd: updatedDaemonTask.estimatedCostUsd || null,
            });
          }
          daemonStore.fetchTaskLogs(initialDisplayableTask.taskId).then((daemonLogEntries) => {
            setLogEntries(
              daemonLogEntries.map((daemonLogEntry) => ({
                level: daemonLogEntry.level,
                message: daemonLogEntry.message,
                createdAtDisplay: formatDateForDisplay(daemonLogEntry.timestamp) ?? "",
              })),
            );
          });
        });
      } else {
        const localTasks = store.fetchRecentTasks(100);
        const updatedLocalTask = localTasks.find(
          (localTask) => localTask.id === initialDisplayableTask.taskId,
        );
        if (updatedLocalTask) {
          setDisplayableTask(convertTaskRowToDisplayableTask(updatedLocalTask));
        }
        const localLogRows = store.fetchTaskLogs(initialDisplayableTask.taskId);
        setLogEntries(
          localLogRows.map((localLogRow) => ({
            level: localLogRow.level,
            message: localLogRow.message,
            createdAtDisplay: localLogRow.created_at,
          })),
        );
      }
    };

    const interval = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);
    return () => clearInterval(interval);
  }, [store, daemonStore, initialDisplayableTask.taskId]);

  const statusColor = STATUS_COLORS[displayableTask.taskStatus] ?? COLORS.textMuted;
  const statusIcon = STATUS_ICONS[displayableTask.taskStatus] ?? "?";

  let parsedParameters: Record<string, string> = {};
  try {
    parsedParameters = JSON.parse(displayableTask.parametersJson);
  } catch {
    // noop
  }

  const shortTaskId = displayableTask.taskId.slice(0, 8);

  const descriptionPreview = displayableTask.taskDescription
    ? displayableTask.taskDescription.length > 80
      ? displayableTask.taskDescription.slice(0, 80) + "..."
      : displayableTask.taskDescription
    : "";

  const promptPreview = parsedParameters.prompt
    ? parsedParameters.prompt.length > 120
      ? parsedParameters.prompt.slice(0, 120) + "..."
      : parsedParameters.prompt
    : "";

  const detailFields: Array<{ label: string; value: string; color?: string }> = [
    { label: "id", value: shortTaskId },
    { label: "status", value: displayableTask.taskStatus, color: statusColor },
    { label: "trigger", value: displayableTask.triggerType },
    { label: "priority", value: displayableTask.taskPriority },
    { label: "created", value: displayableTask.createdAtDisplay },
  ];

  if (!isDaemonModeActive) {
    detailFields.splice(3, 0, { label: "policy", value: displayableTask.approvalPolicy });
  }

  if (displayableTask.startedAtDisplay) {
    detailFields.push({ label: "started", value: displayableTask.startedAtDisplay });
  }
  if (displayableTask.completedAtDisplay) {
    detailFields.push({ label: "ended", value: displayableTask.completedAtDisplay });
  }
  if (parsedParameters.tags) {
    detailFields.push({ label: "tags", value: parsedParameters.tags });
  }

  if (isDaemonModeActive) {
    if (displayableTask.workerPid) {
      detailFields.push({ label: "worker pid", value: String(displayableTask.workerPid) });
    }
    if (displayableTask.promptTokens) {
      detailFields.push({ label: "prompt tkn", value: String(displayableTask.promptTokens) });
    }
    if (displayableTask.completionTokens) {
      detailFields.push({ label: "compl tkn", value: String(displayableTask.completionTokens) });
    }
    if (displayableTask.estimatedCostUsd) {
      detailFields.push({
        label: "cost",
        value: "$" + displayableTask.estimatedCostUsd.toFixed(4),
        color: COLORS.yellow,
      });
    }
  }

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box paddingBottom={1} width="100%">
        <text fg={COLORS.textSecondary}>{"esc back"}</text>
      </box>

      <scrollbox flexGrow={1} width="100%">
        <box flexDirection="column" width="100%">
          <box backgroundColor={COLORS.card} flexDirection="column" padding={1} width="100%">
            <box width="100%">
              <text fg={COLORS.text}>{statusIcon + " " + displayableTask.taskName}</text>
            </box>
            <box width="100%" height={1} />
            {detailFields.map((field) => (
              <box flexDirection="row" width="100%">
                <text fg={COLORS.textMuted}>{"  " + field.label.padEnd(12)}</text>
                <text fg={field.color ?? COLORS.textSecondary}>{field.value}</text>
              </box>
            ))}
          </box>

          {descriptionPreview ? (
            <box
              backgroundColor={COLORS.card}
              flexDirection="column"
              padding={1}
              width="100%"
              marginTop={1}
            >
              <box width="100%">
                <text fg={COLORS.textMuted}>{"description"}</text>
              </box>
              <box width="100%">
                <text fg={COLORS.text}>{"  " + descriptionPreview}</text>
              </box>
            </box>
          ) : null}

          {promptPreview ? (
            <box
              backgroundColor={COLORS.card}
              flexDirection="column"
              padding={1}
              width="100%"
              marginTop={1}
            >
              <box width="100%">
                <text fg={COLORS.textMuted}>{"prompt"}</text>
              </box>
              <box width="100%">
                <text fg={COLORS.text}>{"  " + promptPreview}</text>
              </box>
            </box>
          ) : null}

          {displayableTask.taskOutput ? (
            <box
              backgroundColor={COLORS.card}
              flexDirection="column"
              padding={1}
              width="100%"
              marginTop={1}
            >
              <box width="100%">
                <text fg={COLORS.textMuted}>{"output"}</text>
              </box>
              <box width="100%">
                <text fg={COLORS.text}>{"  " + displayableTask.taskOutput}</text>
              </box>
            </box>
          ) : null}

          {displayableTask.errorMessage ? (
            <box
              backgroundColor={COLORS.card}
              flexDirection="column"
              padding={1}
              width="100%"
              marginTop={1}
            >
              <box width="100%">
                <text fg={COLORS.red}>{"error"}</text>
              </box>
              <box width="100%">
                <text fg={COLORS.text}>{"  " + displayableTask.errorMessage}</text>
              </box>
            </box>
          ) : null}

          {logEntries.length > 0 ? (
            <box
              backgroundColor={COLORS.card}
              flexDirection="column"
              padding={1}
              width="100%"
              marginTop={1}
            >
              <box width="100%">
                <text fg={COLORS.textMuted}>{"logs (" + logEntries.length + ")"}</text>
              </box>
              {logEntries.map((logEntry, index) => {
                const levelColor =
                  logEntry.level === "error"
                    ? COLORS.red
                    : logEntry.level === "warn"
                      ? COLORS.yellow
                      : COLORS.textSecondary;
                return (
                  <box key={index} width="100%">
                    <text fg={levelColor}>
                      {"  " +
                        logEntry.createdAtDisplay +
                        " [" +
                        logEntry.level +
                        "] " +
                        logEntry.message}
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
