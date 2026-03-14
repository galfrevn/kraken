import { useState, useEffect } from "react";
import { COLORS, STATUS_ICONS, STATUS_COLORS } from "@/theme.ts";
import type { TuiStore, ServiceHealth, TaskSummary, ScheduledItem } from "@/store.ts";
import type { TaskRow } from "@core/storage/database.ts";
import type { PluginRegistry } from "@core/plugins/registry.ts";
import { Avatar } from "@/avatar.tsx";

const REFRESH_INTERVAL_MILLISECONDS = 3_000;

interface DashboardViewProps {
  store: TuiStore;
  pluginRegistry: PluginRegistry;
}

export function DashboardView({ store, pluginRegistry }: DashboardViewProps) {
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
  const [scheduledItems, setScheduledItems] = useState<ScheduledItem[]>([]);
  const plugins = pluginRegistry.getLoadedPlugins();

  useEffect(() => {
    const refresh = async () => {
      const [fetchedHealth, fetchedItems] = await Promise.all([
        store.fetchServiceHealth(),
        store.fetchScheduledItems(),
      ]);
      setHealth(fetchedHealth);
      setSummary(store.fetchTaskSummary());
      setRecentTasks(store.fetchRecentTasks(8));
      setScheduledItems(fetchedItems);
    };

    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);
    return () => clearInterval(interval);
  }, [store]);

  const connectedColor = (connected: boolean) => (connected ? COLORS.green : COLORS.red);
  const connectedLabel = (connected: boolean) => (connected ? "connected" : "offline");

  const avatarState = summary.running > 0 ? ("working" as const) : ("idle" as const);

  return (
    <box flexDirection="column" gap={1} width="100%" flexGrow={1}>
      <box flexDirection="row" gap={2}>
        <box backgroundColor={COLORS.card} flexDirection="row" padding={1} flexGrow={1}>
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

        <box backgroundColor={COLORS.card} flexDirection="column" padding={1} flexGrow={1}>
          <text fg={COLORS.textSecondary}>tasks</text>
          <text fg={COLORS.yellow}>{"  ○ pending:   " + summary.pending}</text>
          <text fg={COLORS.cyan}>{"  ◷ scheduled: " + summary.scheduled}</text>
          <text fg={COLORS.blue}>{"  ▶ running:   " + summary.running}</text>
          <text fg={COLORS.green}>{"  ✓ completed: " + summary.completed}</text>
          <text fg={COLORS.red}>{"  ✗ failed:    " + summary.failed}</text>
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
          {recentTasks.length === 0 ? (
            <text fg={COLORS.textMuted}>{"  no tasks yet"}</text>
          ) : (
            recentTasks.map((task) => {
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
          {scheduledItems.length === 0 ? (
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
