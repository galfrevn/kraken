import type { AgentDatabase, TaskRow, TaskLogRow } from "@core/storage/database.ts";
import type { TaskQueueManager } from "@core/queue/manager.ts";
import type { SchedulerClient } from "@core/clients/scheduler.ts";
import type { GatewayClient } from "@core/clients/gateway.ts";
import type { TimerManager, TimerSummary } from "@core/scheduling/timers.ts";

export interface ServiceHealth {
  gateway: boolean;
  scheduler: boolean;
  gatewayVersion: string;
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

export class TuiStore {
  readonly database: AgentDatabase;
  readonly taskQueueManager: TaskQueueManager;
  private gatewayClient: GatewayClient;
  private schedulerClient: SchedulerClient;
  private timerManager: TimerManager;

  constructor(
    database: AgentDatabase,
    taskQueueManager: TaskQueueManager,
    gatewayClient: GatewayClient,
    schedulerClient: SchedulerClient,
    timerManager: TimerManager,
  ) {
    this.database = database;
    this.taskQueueManager = taskQueueManager;
    this.gatewayClient = gatewayClient;
    this.schedulerClient = schedulerClient;
    this.timerManager = timerManager;
  }

  async fetchServiceHealth(): Promise<ServiceHealth> {
    const health: ServiceHealth = {
      gateway: false,
      scheduler: false,
      gatewayVersion: "",
    };

    try {
      const response = await this.gatewayClient.healthCheck({});
      health.gateway = response.healthy;
      health.gatewayVersion = response.version;
    } catch {
      health.gateway = false;
    }

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

  fetchRecentTasks(limit: number = 20): TaskRow[] {
    return this.database.listTasks({ limit });
  }

  fetchTaskLogs(taskId: string): TaskLogRow[] {
    return this.database.getTaskLogs(taskId);
  }

  fetchAllLogs(limit: number = 100): TaskLogRow[] {
    return this.database.listRecentLogs(limit);
  }

  approveTask(taskId: string): void {
    this.taskQueueManager.approveTask(taskId);
  }

  rejectTask(taskId: string, reason: string): void {
    this.taskQueueManager.rejectTask(taskId, reason);
  }
}
