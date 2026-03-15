import type { AgentDatabase, TaskRow, TaskLogRow, EngineLogRow } from "@core/storage/database.ts";
import type { TaskQueueManager } from "@core/queue/manager.ts";
import type { SchedulerClient } from "@core/clients/scheduler.ts";
import type { TimerManager, TimerSummary } from "@core/scheduling/timers.ts";

export interface ServiceHealth {
  scheduler: boolean;
}

export interface TaskSummary {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  scheduled: number;
  total: number;
  awaitingReview: number;
}

export interface ScheduledItem {
  id: string;
  title: string;
  type: "timer" | "cron";
  detail: string; // remaining time for timers, cron expression for crons
  enabled?: boolean;
}

export class TuiStore {
  readonly database: AgentDatabase;
  readonly taskQueueManager: TaskQueueManager;
  private schedulerClient: SchedulerClient;
  private timerManager: TimerManager;

  constructor(
    database: AgentDatabase,
    taskQueueManager: TaskQueueManager,
    schedulerClient: SchedulerClient,
    timerManager: TimerManager,
  ) {
    this.database = database;
    this.taskQueueManager = taskQueueManager;
    this.schedulerClient = schedulerClient;
    this.timerManager = timerManager;
  }

  async fetchServiceHealth(): Promise<ServiceHealth> {
    const health: ServiceHealth = {
      scheduler: false,
    };

    try {
      await this.schedulerClient.listCrons({});
      health.scheduler = true;
    } catch {
      health.scheduler = false;
    }

    return health;
  }

  fetchTaskSummary(): TaskSummary {
    const pending = this.database.getTaskCount("pending");
    const running = this.database.getTaskCount("running");
    const completed = this.database.getTaskCount("completed");
    const failed = this.database.getTaskCount("failed");
    const scheduled = this.timerManager.count();
    const awaitingReview = this.taskQueueManager.listTasksAwaitingReview().length;

    return {
      pending,
      running,
      completed,
      failed,
      scheduled,
      total: pending + running + completed + failed + scheduled,
      awaitingReview,
    };
  }

  fetchPendingTimers(): TimerSummary[] {
    return this.timerManager.list();
  }

  async fetchScheduledItems(): Promise<ScheduledItem[]> {
    const items: ScheduledItem[] = [];

    // Local one-shot timers
    for (const timer of this.timerManager.list()) {
      const mins = Math.ceil(timer.remainingMs / 60_000);
      items.push({
        id: timer.id,
        title: timer.title,
        type: "timer",
        detail: mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`,
      });
    }

    // Recurring crons from scheduler service
    try {
      const response = await this.schedulerClient.listCrons({});
      for (const cron of response.crons) {
        items.push({
          id: cron.cronId,
          title: cron.name,
          type: "cron",
          detail: cron.cronExpression,
          enabled: cron.enabled,
        });
      }
    } catch {
      // Scheduler offline — skip crons silently
    }

    return items;
  }

  fetchRecentTasks(limit: number = 20): TaskRow[] {
    return this.database.listTasks({ limit });
  }

  fetchTaskLogs(taskId: string): TaskLogRow[] {
    return this.database.getTaskLogs(taskId);
  }

  fetchAllLogs(limit: number = 100): TaskLogRow[] {
    return this.database.listRecentLogs(limit);
  }

  fetchEngineLogs(limit: number = 200): EngineLogRow[] {
    return this.database.listRecentEngineLogs(limit);
  }

  approveTask(taskId: string): void {
    this.taskQueueManager.approveTask(taskId);
  }

  rejectTask(taskId: string, reason: string): void {
    this.taskQueueManager.rejectTask(taskId, reason);
  }
}
