import { useState, useEffect } from "react";
import { COLORS, STATUS_ICONS, STATUS_COLORS } from "@/theme.ts";
import type { TuiStore, ServiceHealth, TaskSummary } from "@/store.ts";
import type { TaskRow } from "@core/storage/database.ts";
import type { TimerSummary } from "@core/scheduling/timers.ts";
import { Avatar } from "@/avatar.tsx";

const REFRESH_INTERVAL_MILLISECONDS = 3_000;

function formatRemainingTime(milliseconds: number): string {
  const totalMinutes = Math.ceil(milliseconds / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

interface DashboardViewProps {
  store: TuiStore;
}

export function DashboardView({ store }: DashboardViewProps) {
  const [health, setHealth] = useState<ServiceHealth>({
    gateway: false,
    scheduler: false,
    gatewayVersion: "",
  });
  const [summary, setSummary] = useState<TaskSummary>({
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    scheduled: 0,
    total: 0,
    awaitingReview: 0,
  });
  const [recentTasks, setRecentTasks] = useState<TaskRow[]>([]);
  const [pendingTimers, setPendingTimers] = useState<TimerSummary[]>([]);

  useEffect(() => {
    const refresh = async () => {
      const [fetchedHealth] = await Promise.all([store.fetchServiceHealth()]);
      setHealth(fetchedHealth);
      setSummary(store.fetchTaskSummary());
      setRecentTasks(store.fetchRecentTasks(8));
      setPendingTimers(store.fetchPendingTimers());
    };

    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);
    return () => clearInterval(interval);
  }, [store]);

  const connectedColor = (connected: boolean) =>
    connected ? COLORS.green : COLORS.red;
  const connectedLabel = (connected: boolean) =>
    connected ? "connected" : "offline";

  const avatarState = summary.running > 0 ? "working" as const : "idle" as const;

  return (
    <box flexDirection="column" gap={1} width="100%" flexGrow={1}>
      <box flexDirection="row" gap={2}>
        <box
          backgroundColor={COLORS.card}
          flexDirection="row"
          padding={1}
          flexGrow={1}
        >
          <box paddingRight={2}>
            <Avatar state={avatarState} />
          </box>
          <box flexDirection="column">
            <text fg={COLORS.textSecondary}>services</text>
          <text fg={connectedColor(health.gateway)}>
            {"  ● gateway:   " + connectedLabel(health.gateway)}
            {health.gatewayVersion ? ` (v${health.gatewayVersion})` : ""}
          </text>
          <text fg={connectedColor(health.scheduler)}>
            {"  ● scheduler: " + connectedLabel(health.scheduler)}
          </text>
          </box>
        </box>

        <box
          backgroundColor={COLORS.card}
          flexDirection="column"
          padding={1}
          flexGrow={1}
        >
          <text fg={COLORS.textSecondary}>tasks</text>
          <text fg={COLORS.yellow}>{"  ○ pending:   " + summary.pending}</text>
          <text fg={COLORS.cyan}>{"  ◷ scheduled: " + summary.scheduled}</text>
          <text fg={COLORS.blue}>{"  ▶ running:   " + summary.running}</text>
          <text fg={COLORS.green}>{"  ✓ completed: " + summary.completed}</text>
          <text fg={COLORS.red}>{"  ✗ failed:    " + summary.failed}</text>
        </box>

        <box
          backgroundColor={COLORS.card}
          flexDirection="column"
          padding={1}
          flexGrow={1}
        >
          <text fg={COLORS.textSecondary}>info</text>
          <text fg={COLORS.text}>{"  total:    " + summary.total}</text>
          <text fg={summary.awaitingReview > 0 ? COLORS.yellow : COLORS.textMuted}>
            {"  reviews:  " + summary.awaitingReview}
          </text>
        </box>
      </box>

      <box flexDirection="row" gap={2} flexGrow={1}>
        <box
          backgroundColor={COLORS.card}
          flexDirection="column"
          padding={1}
          flexGrow={1}
        >
          <text fg={COLORS.textSecondary}>recent activity</text>
          {recentTasks.length === 0 ? (
            <text fg={COLORS.textMuted}>{"  no tasks yet"}</text>
          ) : (
            recentTasks.map((task) => {
              const icon = STATUS_ICONS[task.status] ?? "?";
              const color = STATUS_COLORS[task.status] ?? COLORS.textMuted;
              const reviewTag =
                task.approval_policy === "review_required" &&
                task.status === "pending"
                  ? " [review]"
                  : "";
              return (
                <text key={task.id} fg={color}>
                  {"  " +
                    icon +
                    " " +
                    task.name +
                    reviewTag +
                    "  " +
                    task.id.slice(0, 8)}
                </text>
              );
            })
          )}
        </box>

        <box
          backgroundColor={COLORS.card}
          flexDirection="column"
          padding={1}
          flexGrow={1}
        >
          <text fg={COLORS.textSecondary}>scheduled timers</text>
          {pendingTimers.length === 0 ? (
            <text fg={COLORS.textMuted}>{"  no timers scheduled"}</text>
          ) : (
            pendingTimers.map((timer) => (
              <text key={timer.id} fg={COLORS.cyan}>
                {"  ◷ " +
                  timer.title +
                  "  " +
                  formatRemainingTime(timer.remainingMs) +
                  "  " +
                  timer.id.slice(0, 8)}
              </text>
            ))
          )}
        </box>
      </box>
    </box>
  );
}
