import { useState, useEffect } from "react";
import { COLORS, STATUS_ICONS, STATUS_COLORS } from "@/theme.ts";
import type { TuiStore, ServiceHealth, TaskSummary, ScheduledItem } from "@/store.ts";
import type { DaemonStore, DaemonServiceHealth, DaemonTaskSummary, DaemonTaskInfo } from "@/daemon-store.ts";
import type { TaskRow } from "@core/storage/database.ts";
import type { PluginRegistry } from "@core/plugins/registry.ts";
import { Avatar } from "@/avatar.tsx";

const REFRESH_INTERVAL_MILLISECONDS = 3_000;

interface DashboardViewProps {
  store: TuiStore;
  daemonStore?: DaemonStore | null;
  pluginRegistry: PluginRegistry;
}

function formatUptimeDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

const DAEMON_TASK_STATUS_ICONS: Record<string, string> = {
  pending: "○",
  running: "▶",
  completed: "✓",
  failed: "✗",
};

const DAEMON_TASK_STATUS_COLORS: Record<string, string> = {
  pending: COLORS.yellow,
  running: COLORS.blue,
  completed: COLORS.green,
  failed: COLORS.red,
};

export function DashboardView({ store, daemonStore, pluginRegistry }: DashboardViewProps) {
  const [localHealth, setLocalHealth] = useState<ServiceHealth>({
    gateway: false,
    scheduler: false,
    gatewayVersion: "",
  });
  const [localTaskSummary, setLocalTaskSummary] = useState<TaskSummary>({
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    scheduled: 0,
    total: 0,
    awaitingReview: 0,
  });
  const [localRecentTasks, setLocalRecentTasks] = useState<TaskRow[]>([]);
  const [scheduledItems, setScheduledItems] = useState<ScheduledItem[]>([]);

  const [daemonHealth, setDaemonHealth] = useState<DaemonServiceHealth>({
    healthy: false,
    uptimeSeconds: 0,
    activeWorkers: 0,
    maxWorkers: 0,
    pendingTasks: 0,
    completedToday: 0,
    gatewayConnected: false,
  });
  const [daemonTaskSummary, setDaemonTaskSummary] = useState<DaemonTaskSummary>({
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  });
  const [daemonRecentTasks, setDaemonRecentTasks] = useState<DaemonTaskInfo[]>([]);

  const isDaemonMode = !!daemonStore;
  const plugins = pluginRegistry.getLoadedPlugins();

  useEffect(() => {
    const refreshFromLocalStore = async () => {
      const [fetchedHealth, fetchedItems] = await Promise.all([
        store.fetchServiceHealth(),
        store.fetchScheduledItems(),
      ]);
      setLocalHealth(fetchedHealth);
      setLocalTaskSummary(store.fetchTaskSummary());
      setLocalRecentTasks(store.fetchRecentTasks(8));
      setScheduledItems(fetchedItems);
    };

    const refreshFromDaemonStore = async () => {
      if (!daemonStore) return;
      const [fetchedDaemonHealth, fetchedDaemonTaskSummary, fetchedDaemonRecentTasks] =
        await Promise.all([
          daemonStore.fetchServiceHealth(),
          daemonStore.fetchTaskSummary(),
          daemonStore.fetchRecentTasks(8),
        ]);
      setDaemonHealth(fetchedDaemonHealth);
      setDaemonTaskSummary(fetchedDaemonTaskSummary);
      setDaemonRecentTasks(fetchedDaemonRecentTasks);
    };

    const refresh = async () => {
      if (isDaemonMode) {
        await refreshFromDaemonStore();
      } else {
        await refreshFromLocalStore();
      }
    };

    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);
    return () => clearInterval(interval);
  }, [store, daemonStore, isDaemonMode]);

  const connectedColor = (connected: boolean) => (connected ? COLORS.green : COLORS.red);
  const connectedLabel = (connected: boolean) => (connected ? "connected" : "offline");

  const runningTaskCount = isDaemonMode ? daemonTaskSummary.running : localTaskSummary.running;
  const avatarState = runningTaskCount > 0 ? ("working" as const) : ("idle" as const);

  return (
    <box flexDirection="column" gap={1} width="100%" flexGrow={1}>
      <box flexDirection="row" gap={2}>
        <box backgroundColor={COLORS.card} flexDirection="row" padding={1} flexGrow={1}>
          <box paddingRight={2}>
            <Avatar state={avatarState} />
          </box>
          <box flexDirection="column">
            <text fg={COLORS.textSecondary}>services</text>
            {isDaemonMode ? (
              <>
                <text fg={connectedColor(daemonHealth.healthy)}>
                  {"  ● daemon:    " + connectedLabel(daemonHealth.healthy)}
                </text>
                <text fg={connectedColor(daemonHealth.gatewayConnected)}>
                  {"  ● gateway:   " + connectedLabel(daemonHealth.gatewayConnected)}
                </text>
                <text fg={COLORS.textSecondary}>
                  {"  ↑ uptime:    " + formatUptimeDuration(daemonHealth.uptimeSeconds)}
                </text>
                <text fg={COLORS.textSecondary}>
                  {"  ◈ workers:   " + daemonHealth.activeWorkers + "/" + daemonHealth.maxWorkers}
                </text>
              </>
            ) : (
              <>
                <text fg={connectedColor(localHealth.gateway)}>
                  {"  ● gateway:   " + connectedLabel(localHealth.gateway)}
                  {localHealth.gatewayVersion ? ` (v${localHealth.gatewayVersion})` : ""}
                </text>
                <text fg={connectedColor(localHealth.scheduler)}>
                  {"  ● scheduler: " + connectedLabel(localHealth.scheduler)}
                </text>
              </>
            )}
          </box>
        </box>

        <box backgroundColor={COLORS.card} flexDirection="column" padding={1} flexGrow={1}>
          <text fg={COLORS.textSecondary}>tasks</text>
          {isDaemonMode ? (
            <>
              <text fg={COLORS.yellow}>{"  ○ pending:   " + daemonTaskSummary.pending}</text>
              <text fg={COLORS.blue}>{"  ▶ running:   " + daemonTaskSummary.running}</text>
              <text fg={COLORS.green}>{"  ✓ completed: " + daemonTaskSummary.completed}</text>
              <text fg={COLORS.red}>{"  ✗ failed:    " + daemonTaskSummary.failed}</text>
              <text fg={COLORS.cyan}>{"  ✓ today:     " + daemonHealth.completedToday}</text>
            </>
          ) : (
            <>
              <text fg={COLORS.yellow}>{"  ○ pending:   " + localTaskSummary.pending}</text>
              <text fg={COLORS.cyan}>{"  ◷ scheduled: " + localTaskSummary.scheduled}</text>
              <text fg={COLORS.blue}>{"  ▶ running:   " + localTaskSummary.running}</text>
              <text fg={COLORS.green}>{"  ✓ completed: " + localTaskSummary.completed}</text>
              <text fg={COLORS.red}>{"  ✗ failed:    " + localTaskSummary.failed}</text>
            </>
          )}
        </box>

        <box backgroundColor={COLORS.card} flexDirection="column" padding={1} flexGrow={1}>
          <text fg={COLORS.textSecondary}>plugins</text>
          {plugins.length === 0 ? (
            <text fg={COLORS.textMuted}>{"  no plugins installed"}</text>
          ) : (
            plugins.map((p) => (
              <text key={p.plugin.name} fg={p.enabled ? COLORS.green : COLORS.textMuted}>
                {"  " + (p.enabled ? "●" : "○") + " " + p.plugin.name + " v" + p.plugin.version}
              </text>
            ))
          )}
        </box>
      </box>

      <box flexDirection="row" gap={2} flexGrow={1}>
        <box backgroundColor={COLORS.card} flexDirection="column" padding={1} flexGrow={1}>
          <text fg={COLORS.textSecondary}>recent activity</text>
          {isDaemonMode ? (
            daemonRecentTasks.length === 0 ? (
              <text fg={COLORS.textMuted}>{"  no tasks yet"}</text>
            ) : (
              daemonRecentTasks.map((daemonTask) => {
                const icon = DAEMON_TASK_STATUS_ICONS[daemonTask.taskStatus] ?? "?";
                const color = DAEMON_TASK_STATUS_COLORS[daemonTask.taskStatus] ?? COLORS.textMuted;
                return (
                  <text key={daemonTask.taskId} fg={color}>
                    {"  " + icon + " " + daemonTask.taskName + "  " + daemonTask.taskId.slice(0, 8)}
                  </text>
                );
              })
            )
          ) : localRecentTasks.length === 0 ? (
            <text fg={COLORS.textMuted}>{"  no tasks yet"}</text>
          ) : (
            localRecentTasks.map((task) => {
              const icon = STATUS_ICONS[task.status] ?? "?";
              const color = STATUS_COLORS[task.status] ?? COLORS.textMuted;
              const reviewTag =
                task.approval_policy === "review_required" && task.status === "pending"
                  ? " [review]"
                  : "";
              return (
                <text key={task.id} fg={color}>
                  {"  " + icon + " " + task.name + reviewTag + "  " + task.id.slice(0, 8)}
                </text>
              );
            })
          )}
        </box>

        <box backgroundColor={COLORS.card} flexDirection="column" padding={1} flexGrow={1}>
          <text fg={COLORS.textSecondary}>schedules</text>
          {isDaemonMode ? (
            <text fg={COLORS.textMuted}>{"  managed by daemon"}</text>
          ) : scheduledItems.length === 0 ? (
            <text fg={COLORS.textMuted}>{"  no schedules active"}</text>
          ) : (
            scheduledItems.map((item) => {
              const icon = item.type === "cron" ? "↻" : "◷";
              const color = item.enabled === false ? COLORS.textMuted : COLORS.cyan;
              return (
                <text key={item.id} fg={color}>
                  {"  " + icon + " " + item.title + "  " + item.detail + "  " + item.id.slice(0, 8)}
                </text>
              );
            })
          )}
        </box>
      </box>
    </box>
  );
}
