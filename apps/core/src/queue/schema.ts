export const TASK_STATUS = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const TASK_PRIORITY = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
} as const;

export type TaskPriority = (typeof TASK_PRIORITY)[keyof typeof TASK_PRIORITY];

export const TRIGGER_TYPE = {
  manual: "manual",
  cron: "cron",
  webhook: "webhook",
  fileChange: "file_change",
  companion: "companion",
} as const;

export type TriggerType = (typeof TRIGGER_TYPE)[keyof typeof TRIGGER_TYPE];

export const APPROVAL_POLICY = {
  auto: "auto",
  reviewRequired: "review_required",
} as const;

export type ApprovalPolicy = (typeof APPROVAL_POLICY)[keyof typeof APPROVAL_POLICY];

export interface Task {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  triggerType: TriggerType;
  approvalPolicy: ApprovalPolicy;
  parameters: Record<string, string>;
  output: string;
  errorMessage: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface TaskSubmission {
  name: string;
  description?: string;
  priority?: TaskPriority;
  triggerType?: TriggerType;
  approvalPolicy?: ApprovalPolicy;
  parameters?: Record<string, string>;
}

export const TASK_EVENT_TYPE = {
  submitted: "submitted",
  approved: "approved",
  started: "started",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export type TaskEventType = (typeof TASK_EVENT_TYPE)[keyof typeof TASK_EVENT_TYPE];

export interface TaskEvent {
  type: TaskEventType;
  task: Task;
  timestamp: Date;
}

export type TaskEventListener = (event: TaskEvent) => void;

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  [TASK_PRIORITY.critical]: 4,
  [TASK_PRIORITY.high]: 3,
  [TASK_PRIORITY.medium]: 2,
  [TASK_PRIORITY.low]: 1,
};

export function comparePriorityDescending(first: Task, second: Task): number {
  const weightDifference = PRIORITY_WEIGHT[second.priority] - PRIORITY_WEIGHT[first.priority];
  if (weightDifference !== 0) return weightDifference;
  return first.createdAt.getTime() - second.createdAt.getTime();
}

const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TASK_STATUS.pending]: [TASK_STATUS.running, TASK_STATUS.cancelled],
  [TASK_STATUS.running]: [TASK_STATUS.completed, TASK_STATUS.failed, TASK_STATUS.cancelled],
  [TASK_STATUS.completed]: [],
  [TASK_STATUS.failed]: [],
  [TASK_STATUS.cancelled]: [],
};

export function isValidStatusTransition(fromStatus: TaskStatus, toStatus: TaskStatus): boolean {
  return VALID_STATUS_TRANSITIONS[fromStatus].includes(toStatus);
}
