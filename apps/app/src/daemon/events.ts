import type { DaemonEvent } from "@kraken/sdk";
import { getDaemon } from "@/daemon/client.ts";
import { Bus, Events } from "@/bus/index.ts";

const SSE_RECONNECT_DELAY_MILLISECONDS = 3000;

const DAEMON_EVENT_TYPE_TO_BUS_TOPIC: Record<string, string> = {
  "task.started": Events.Daemon.TaskStarted,
  "task.completed": Events.Daemon.TaskCompleted,
  "task.failed": Events.Daemon.TaskFailed,
  "task.cancelled": Events.Daemon.TaskCancelled,
  "trigger.fired": Events.Daemon.TriggerFired,
  "pr.created": Events.Daemon.PullRequestCreated,
  "daily.digest": Events.Daemon.DailyDigest,
  "cost.warning": Events.Daemon.CostWarning,
  "rate_limit.exceeded": Events.Daemon.RateLimitExceeded,
};

let activeSubscription: { unsubscribe: () => void } | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectToDaemonEvents(): void {
  if (activeSubscription) return;

  const daemon = getDaemon();

  activeSubscription = daemon.subscribeEvents({
    onEvent(eventType: string, event: DaemonEvent) {
      const busTopic = DAEMON_EVENT_TYPE_TO_BUS_TOPIC[eventType];
      if (busTopic) {
        Bus.publish(busTopic, event);
      }
    },
    onConnect() {
      Bus.publish(Events.Daemon.Connected, {});
    },
    onDisconnect() {
      Bus.publish(Events.Daemon.Disconnected, {});
      activeSubscription = null;
      scheduleReconnect();
    },
    onError() {
      activeSubscription = null;
      scheduleReconnect();
    },
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToDaemonEvents();
  }, SSE_RECONNECT_DELAY_MILLISECONDS);
}

export function startDaemonEventBridge(): void {
  connectToDaemonEvents();
}

export function stopDaemonEventBridge(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeSubscription) {
    activeSubscription.unsubscribe();
    activeSubscription = null;
  }
}
