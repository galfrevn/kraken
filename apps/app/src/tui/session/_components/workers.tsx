import { useState, useEffect } from "react";
import { type ChoiceContext } from "@opentui-ui/dialog/react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "@/tui/_context/theme.tsx";
import { getDaemon } from "@/daemon/client.ts";
import type { StatusResponse, TaskDetails } from "@kraken/sdk";

export const WorkersContent = ({ resolve }: ChoiceContext<void>) => {
  const { theme } = useTheme();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [tasks, setTasks] = useState<TaskDetails[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const daemonStatus = await getDaemon().status();
        setStatus(daemonStatus);
      } catch {
        setError("Cannot connect to daemon");
      }
      try {
        const taskList = await getDaemon().tasks.list({ limit: 20 });
        setTasks(taskList);
      } catch {}
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "escape") {
      resolve(undefined as unknown as void);
    }
  });

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const formatTimeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ago`;
  };

  const statusColor = (taskStatus: string) => {
    switch (taskStatus) {
      case "running":
        return theme.warning;
      case "completed":
        return theme.success;
      case "failed":
        return theme.error;
      case "pending":
        return theme.textMuted;
      default:
        return theme.text;
    }
  };

  const statusIcon = (taskStatus: string) => {
    switch (taskStatus) {
      case "running":
        return "◉";
      case "completed":
        return "✓";
      case "failed":
        return "✗";
      default:
        return "◌";
    }
  };

  const taskCounts = status?.tasks ?? {};
  const runningCount = taskCounts["running"] ?? 0;
  const pendingCount = taskCounts["pending"] ?? 0;
  const completedCount = taskCounts["completed"] ?? 0;
  const failedCount = taskCounts["failed"] ?? 0;

  return (
    <box flexDirection="column" width="100%" paddingY={1}>
      <box paddingX={4}>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text attributes={TextAttributes.BOLD} fg={theme.text} content="Worker Health" />
          <text fg={theme.textMuted} content="esc close" />
        </box>
      </box>

      {error ? (
        <box paddingX={4} paddingTop={1}>
          <text fg={theme.error} content={`✖ ${error}`} />
        </box>
      ) : !status ? (
        <box paddingX={4} paddingTop={1}>
          <text fg={theme.textMuted} content="Loading..." />
        </box>
      ) : (
        <>
          {/* Status overview */}
          <box paddingX={4} paddingTop={1} flexDirection="row" gap={3}>
            <text>
              <span fg={theme.success}>● </span>
              <span fg={theme.textMuted}>uptime </span>
              <span fg={theme.text}>{formatUptime(status.uptime_seconds)}</span>
            </text>
            {status.workers && (
              <text>
                <span fg={theme.textMuted}>workers </span>
                <span fg={theme.text}>{`${status.workers.active}/${status.workers.max}`}</span>
              </text>
            )}
          </box>

          {/* Task counters */}
          <box paddingX={4} paddingTop={1} flexDirection="row" gap={3}>
            <text>
              <span fg={theme.warning}>◉ </span>
              <span fg={theme.text}>{`${runningCount} running`}</span>
            </text>
            <text>
              <span fg={theme.textMuted}>◌ </span>
              <span fg={theme.text}>{`${pendingCount} pending`}</span>
            </text>
            <text>
              <span fg={theme.success}>✓ </span>
              <span fg={theme.text}>{`${completedCount} done`}</span>
            </text>
            <text>
              <span fg={theme.error}>✗ </span>
              <span fg={theme.text}>{`${failedCount} failed`}</span>
            </text>
          </box>

          {/* Recent tasks */}
          {tasks.length > 0 && (
            <box paddingX={4} paddingTop={1} flexDirection="column">
              <text attributes={TextAttributes.BOLD} fg={theme.text} content="Recent tasks" />
              <box height={1} />
              {tasks.slice(0, 10).map((task) => (
                <box key={task.id} flexDirection="row" gap={2}>
                  <text fg={statusColor(task.status)} content={statusIcon(task.status)} />
                  <text
                    fg={theme.text}
                    content={
                      task.name
                        ? task.name.slice(0, 50) + (task.name.length > 50 ? "..." : "")
                        : task.id.slice(0, 8)
                    }
                    wrapMode="none"
                  />
                  {task.started_at && (
                    <text fg={theme.textMuted} content={formatTimeAgo(task.started_at)} />
                  )}
                </box>
              ))}
            </box>
          )}
        </>
      )}
    </box>
  );
};
