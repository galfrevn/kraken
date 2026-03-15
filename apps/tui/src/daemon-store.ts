import type { DaemonConnection } from "@/daemon-connection.ts";
import type { DaemonTask, TaskLogEntry } from "@gen/agent/v1/daemon_pb.ts";
import type { Timestamp } from "@bufbuild/protobuf/wkt";

export interface DaemonServiceHealth {
  healthy: boolean;
  uptimeSeconds: number;
  activeWorkers: number;
  maxWorkers: number;
  pendingTasks: number;
  completedToday: number;
  gatewayConnected: boolean;
}

export interface DaemonTaskSummary {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface DaemonTaskInfo {
  taskId: string;
  taskName: string;
  taskStatus: string;
  taskPriority: number;
  triggerType: string;
  workerPid: number;
  taskOutput: string;
  errorMessage: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  createdAt: Date | undefined;
  startedAt: Date | undefined;
  completedAt: Date | undefined;
}

export interface DaemonTaskLogEntry {
  level: string;
  message: string;
  timestamp: Date | undefined;
}

function convertTimestampToDate(timestamp: Timestamp | undefined): Date | undefined {
  if (!timestamp) return undefined;
  const milliseconds = Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
  return new Date(milliseconds);
}

function convertDaemonTaskToInfo(daemonTask: DaemonTask): DaemonTaskInfo {
  return {
    taskId: daemonTask.id,
    taskName: daemonTask.name,
    taskStatus: daemonTask.status,
    taskPriority: daemonTask.priority,
    triggerType: daemonTask.triggerType,
    workerPid: daemonTask.workerPid,
    taskOutput: daemonTask.output,
    errorMessage: daemonTask.errorMessage,
    promptTokens: Number(daemonTask.promptTokens),
    completionTokens: Number(daemonTask.completionTokens),
    estimatedCostUsd: daemonTask.estimatedCostUsd,
    createdAt: convertTimestampToDate(daemonTask.createdAt),
    startedAt: convertTimestampToDate(daemonTask.startedAt),
    completedAt: convertTimestampToDate(daemonTask.completedAt),
  };
}

function convertLogEntryToDaemonLogEntry(logEntry: TaskLogEntry): DaemonTaskLogEntry {
  return {
    level: logEntry.level,
    message: logEntry.message,
    timestamp: convertTimestampToDate(logEntry.timestamp),
  };
}

export class DaemonStore {
  private daemonConnection: DaemonConnection;

  constructor(daemonConnection: DaemonConnection) {
    this.daemonConnection = daemonConnection;
  }

  async fetchServiceHealth(): Promise<DaemonServiceHealth> {
    try {
      const statusResponse = await this.daemonConnection.getStatus();
      return {
        healthy: statusResponse.healthy,
        uptimeSeconds: Number(statusResponse.uptimeSeconds),
        activeWorkers: statusResponse.activeWorkers,
        maxWorkers: statusResponse.maxWorkers,
        pendingTasks: statusResponse.pendingTasks,
        completedToday: statusResponse.completedTasksToday,
        gatewayConnected: statusResponse.gatewayConnected,
      };
    } catch {
      return {
        healthy: false,
        uptimeSeconds: 0,
        activeWorkers: 0,
        maxWorkers: 0,
        pendingTasks: 0,
        completedToday: 0,
        gatewayConnected: false,
      };
    }
  }

  async fetchTaskSummary(): Promise<DaemonTaskSummary> {
    try {
      const allTasksResponse = await this.daemonConnection.listTasks(undefined, 0);
      const allTasks = allTasksResponse.tasks;

      let pendingCount = 0;
      let runningCount = 0;
      let completedCount = 0;
      let failedCount = 0;

      for (const task of allTasks) {
        switch (task.status) {
          case "pending":
            pendingCount++;
            break;
          case "running":
            runningCount++;
            break;
          case "completed":
            completedCount++;
            break;
          case "failed":
            failedCount++;
            break;
        }
      }

      return {
        pending: pendingCount,
        running: runningCount,
        completed: completedCount,
        failed: failedCount,
      };
    } catch {
      return { pending: 0, running: 0, completed: 0, failed: 0 };
    }
  }

  async fetchRecentTasks(limit: number): Promise<DaemonTaskInfo[]> {
    try {
      const listResponse = await this.daemonConnection.listTasks(undefined, limit);
      return listResponse.tasks.map(convertDaemonTaskToInfo);
    } catch {
      return [];
    }
  }

  async fetchTaskLogs(taskId: string): Promise<DaemonTaskLogEntry[]> {
    try {
      const detailResponse = await this.daemonConnection.getTaskDetail(taskId);
      return detailResponse.logs.map(convertLogEntryToDaemonLogEntry);
    } catch {
      return [];
    }
  }

  async submitTask(
    taskName: string,
    taskDescription: string,
    taskPriority: number,
  ): Promise<string> {
    try {
      const submitResponse = await this.daemonConnection.submitTask(
        taskName,
        taskDescription,
        taskPriority,
      );
      return submitResponse.taskId;
    } catch {
      return "";
    }
  }

  async cancelTask(taskId: string): Promise<boolean> {
    try {
      const cancelResponse = await this.daemonConnection.cancelTask(taskId);
      return cancelResponse.success;
    } catch {
      return false;
    }
  }
}
