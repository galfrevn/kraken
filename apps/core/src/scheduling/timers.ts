import type { TaskQueueManager } from "@/queue/manager.ts";
import type { TaskPriority } from "@/queue/schema.ts";

export interface TimerTaskData {
  title: string;
  description: string;
  prompt: string;
  priority: TaskPriority;
  tags: string[];
}

export interface TimerEntry {
  id: string;
  taskData: TimerTaskData;
  scheduledAt: Date;
  createdAt: Date;
  timeout: ReturnType<typeof setTimeout>;
}

export interface TimerSummary {
  id: string;
  title: string;
  description: string;
  prompt: string;
  priority: string;
  tags: string[];
  scheduledAt: Date;
  createdAt: Date;
  remainingMs: number;
}

const MAX_DELAY_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export class TimerManager {
  private timers = new Map<string, TimerEntry>();
  private taskQueueManager: TaskQueueManager;

  constructor(taskQueueManager: TaskQueueManager) {
    this.taskQueueManager = taskQueueManager;
  }

  scheduleAt(
    taskData: TimerTaskData,
    scheduledAt: Date,
  ): { id: string; scheduledAt: Date; delayMs: number } | { error: string } {
    const now = Date.now();
    const delayMs = scheduledAt.getTime() - now;

    if (delayMs <= 0) {
      return { error: "scheduled time is in the past" };
    }

    if (delayMs > MAX_DELAY_MILLISECONDS) {
      return { error: `maximum delay is 7 days (${Math.round(delayMs / 86_400_000)}d requested)` };
    }

    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      this.fireTimer(id);
    }, delayMs);

    const entry: TimerEntry = {
      id,
      taskData,
      scheduledAt,
      createdAt: new Date(),
      timeout,
    };

    this.timers.set(id, entry);
    return { id, scheduledAt, delayMs };
  }

  scheduleAfter(
    taskData: TimerTaskData,
    delayMs: number,
  ): { id: string; scheduledAt: Date; delayMs: number } | { error: string } {
    const scheduledAt = new Date(Date.now() + delayMs);
    return this.scheduleAt(taskData, scheduledAt);
  }

  cancel(timerId: string): boolean {
    const entry = this.timers.get(timerId);
    if (!entry) return false;

    clearTimeout(entry.timeout);
    this.timers.delete(timerId);
    return true;
  }

  list(): TimerSummary[] {
    const now = Date.now();
    const summaries: TimerSummary[] = [];

    for (const entry of this.timers.values()) {
      summaries.push({
        id: entry.id,
        title: entry.taskData.title,
        description: entry.taskData.description,
        prompt: entry.taskData.prompt,
        priority: entry.taskData.priority,
        tags: entry.taskData.tags,
        scheduledAt: entry.scheduledAt,
        createdAt: entry.createdAt,
        remainingMs: Math.max(0, entry.scheduledAt.getTime() - now),
      });
    }

    return summaries.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  }

  count(): number {
    return this.timers.size;
  }

  cancelAll(): number {
    let count = 0;
    for (const entry of this.timers.values()) {
      clearTimeout(entry.timeout);
      count++;
    }
    this.timers.clear();
    return count;
  }

  private fireTimer(timerId: string): void {
    const entry = this.timers.get(timerId);
    if (!entry) return;

    this.timers.delete(timerId);

    const { taskData } = entry;

    try {
      this.taskQueueManager.submitTask({
        name: taskData.title,
        description: taskData.description,
        priority: taskData.priority,
        triggerType: "cron",
        parameters: {
          prompt: taskData.prompt,
          tags: taskData.tags.join(", "),
          scheduledAt: entry.scheduledAt.toISOString(),
        },
      });
    } catch (error) {
      console.error(`timer "${taskData.title}" failed to submit task:`, error);
    }
  }
}
