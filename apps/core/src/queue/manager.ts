import { AgentDatabase, type TaskRow } from "@/storage/database.ts";
import {
  TASK_STATUS,
  TASK_EVENT_TYPE,
  TASK_PRIORITY,
  TRIGGER_TYPE,
  APPROVAL_POLICY,
  comparePriorityDescending,
  isValidStatusTransition,
  type Task,
  type TaskSubmission,
  type TaskEvent,
  type TaskEventListener,
  type TaskStatus,
} from "@/queue/schema.ts";

function convertRowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as Task["status"],
    priority: row.priority as Task["priority"],
    triggerType: row.trigger_type as Task["triggerType"],
    approvalPolicy: row.approval_policy as Task["approvalPolicy"],
    parameters: JSON.parse(row.parameters),
    output: row.output,
    errorMessage: row.error_message,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  };
}

export class TaskQueueManager {
  private database: AgentDatabase;
  private eventListeners: TaskEventListener[] = [];

  constructor(database: AgentDatabase) {
    this.database = database;
  }

  submitTask(submission: TaskSubmission): Task {
    const taskId = crypto.randomUUID();

    const taskRow = this.database.createTask({
      id: taskId,
      name: submission.name,
      description: submission.description ?? "",
      status: TASK_STATUS.pending,
      priority: submission.priority ?? TASK_PRIORITY.medium,
      trigger_type: submission.triggerType ?? TRIGGER_TYPE.manual,
      approval_policy: submission.approvalPolicy ?? APPROVAL_POLICY.auto,
      parameters: JSON.stringify(submission.parameters ?? {}),
      output: "",
      error_message: "",
    });

    const task = convertRowToTask(taskRow);
    this.emitEvent(TASK_EVENT_TYPE.submitted, task);
    this.database.addTaskLog(task.id, "info", `task submitted: ${task.name}`);
    return task;
  }

  startTask(taskId: string): Task {
    const task = this.getTaskOrThrow(taskId);
    this.validateTransition(task, TASK_STATUS.running);

    this.database.updateTaskStatus(taskId, TASK_STATUS.running);
    const updatedTask = this.getTaskOrThrow(taskId);

    this.emitEvent(TASK_EVENT_TYPE.started, updatedTask);
    this.database.addTaskLog(taskId, "info", "task started");
    return updatedTask;
  }

  completeTask(taskId: string, output: string = ""): Task {
    const task = this.getTaskOrThrow(taskId);
    this.validateTransition(task, TASK_STATUS.completed);

    this.database.updateTaskStatus(taskId, TASK_STATUS.completed, { output });
    const updatedTask = this.getTaskOrThrow(taskId);

    this.emitEvent(TASK_EVENT_TYPE.completed, updatedTask);
    this.database.addTaskLog(taskId, "info", "task completed");
    return updatedTask;
  }

  failTask(taskId: string, errorMessage: string): Task {
    const task = this.getTaskOrThrow(taskId);
    this.validateTransition(task, TASK_STATUS.failed);

    this.database.updateTaskStatus(taskId, TASK_STATUS.failed, { errorMessage });
    const updatedTask = this.getTaskOrThrow(taskId);

    this.emitEvent(TASK_EVENT_TYPE.failed, updatedTask);
    this.database.addTaskLog(taskId, "error", `task failed: ${errorMessage}`);
    return updatedTask;
  }

  approveTask(taskId: string): Task {
    const task = this.getTaskOrThrow(taskId);

    if (task.approvalPolicy !== APPROVAL_POLICY.reviewRequired) {
      throw new Error(`task does not require approval: ${taskId}`);
    }
    if (task.status !== TASK_STATUS.pending) {
      throw new Error(`only pending tasks can be approved (current: ${task.status})`);
    }

    this.database.updateApprovalPolicy(taskId, APPROVAL_POLICY.auto);
    const updatedTask = this.getTaskOrThrow(taskId);

    this.emitEvent(TASK_EVENT_TYPE.approved, updatedTask);
    this.database.addTaskLog(taskId, "info", "task approved for execution");
    return updatedTask;
  }

  rejectTask(taskId: string, reason: string = ""): Task {
    const task = this.getTaskOrThrow(taskId);

    if (task.approvalPolicy !== APPROVAL_POLICY.reviewRequired) {
      throw new Error(`task does not require approval: ${taskId}`);
    }
    if (task.status !== TASK_STATUS.pending) {
      throw new Error(`only pending tasks can be rejected (current: ${task.status})`);
    }

    this.database.updateTaskStatus(taskId, TASK_STATUS.cancelled);
    const updatedTask = this.getTaskOrThrow(taskId);

    this.emitEvent(TASK_EVENT_TYPE.cancelled, updatedTask);
    this.database.addTaskLog(taskId, "info", `task rejected: ${reason || "no reason provided"}`);
    return updatedTask;
  }

  listTasksAwaitingReview(): Task[] {
    const pendingTasks = this.listTasks({ status: TASK_STATUS.pending });
    return pendingTasks.filter((task) => task.approvalPolicy === APPROVAL_POLICY.reviewRequired);
  }

  cancelTask(taskId: string): Task {
    const task = this.getTaskOrThrow(taskId);
    this.validateTransition(task, TASK_STATUS.cancelled);

    this.database.updateTaskStatus(taskId, TASK_STATUS.cancelled);
    const updatedTask = this.getTaskOrThrow(taskId);

    this.emitEvent(TASK_EVENT_TYPE.cancelled, updatedTask);
    this.database.addTaskLog(taskId, "info", "task cancelled");
    return updatedTask;
  }

  getTask(taskId: string): Task | undefined {
    const row = this.database.getTask(taskId);
    return row ? convertRowToTask(row) : undefined;
  }

  listTasks(filters?: { status?: TaskStatus; limit?: number }): Task[] {
    const rows = this.database.listTasks({
      status: filters?.status,
      limit: filters?.limit,
    });
    return rows.map(convertRowToTask);
  }

  getNextPendingTask(): Task | undefined {
    const pendingTasks = this.listTasks({ status: TASK_STATUS.pending });
    if (pendingTasks.length === 0) return undefined;
    return pendingTasks.sort(comparePriorityDescending)[0];
  }

  getRunningTaskCount(): number {
    return this.database.getTaskCount(TASK_STATUS.running);
  }

  addEventListener(listener: TaskEventListener): void {
    this.eventListeners.push(listener);
  }

  removeEventListener(listener: TaskEventListener): void {
    this.eventListeners = this.eventListeners.filter((registered) => registered !== listener);
  }

  private getTaskOrThrow(taskId: string): Task {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`task not found: ${taskId}`);
    }
    return task;
  }

  private validateTransition(task: Task, targetStatus: TaskStatus): void {
    if (!isValidStatusTransition(task.status, targetStatus)) {
      throw new Error(
        `invalid status transition: ${task.status} → ${targetStatus} (task: ${task.id})`,
      );
    }
  }

  private emitEvent(type: TaskEvent["type"], task: Task): void {
    const event: TaskEvent = { type, task, timestamp: new Date() };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (listenerError) {
        console.error(`task event listener error (${type}):`, listenerError);
      }
    }
  }
}
