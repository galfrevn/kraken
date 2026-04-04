export interface ScheduleRequest {
  prompt: string;
  priority?: number;
  agent?: string;
  workdir?: string;
  run_at?: string;
  cron_expression?: string;
  repeat_interval_seconds?: number;
  channel_type?: string;
  channel_chat_id?: string;
}

export interface ScheduleResponse {
  task_id: string;
}

export interface TaskDetails {
  id: string;
  name: string;
  description: string;
  agent: string;
  status: string;
  priority: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  exit_code?: number;
  output?: string;
  error?: string;
  retry_count?: number;
  trigger_id?: string;
  trigger_type?: string;
  trigger_payload?: string;
}

export interface TaskListParams {
  status?: string;
  limit?: number;
  offset?: number;
}

export interface TaskUsageRequest {
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

export interface TaskResultRequest {
  output: string;
  exit_code: number;
}

export interface RetryTaskRequest {
  agent?: string;
}

export interface TaskLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface StatsParams {
  period?: "today" | "week" | "month";
}

export interface StatsResponse {
  completed: number;
  failed: number;
  pending: number;
  running: number;
  tokens: number;
  cost: number;
}

export interface CleanRequest {
  task_days?: number;
  dry_run?: boolean;
}

export interface StatusResponse {
  pid: number;
  uptime_seconds: number;
  port: number;
  workers?: { active: number; max: number };
  tasks: Record<string, number>;
  config_path?: string;
}

export interface CreateObservationRequest {
  session_id: string;
  type?: string;
  title: string;
  content: string;
  project?: string;
  scope?: string;
  topic_key?: string;
  embedding?: number[];
}

export interface CreateObservationResponse {
  id: number;
  revision_count: number;
}

export interface Observation {
  id: number;
  session_id: string;
  type: string;
  title: string;
  content: string;
  project: string;
  scope: string;
  topic_key: string;
  revision_count: number;
  duplicate_count: number;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchParams {
  q: string;
  type?: string;
  limit?: number;
  embedding?: string;
}

export interface MemorySearchResult {
  id: number;
  title: string;
  type: string;
  content: string;
  project: string;
  scope: string;
  topic_key: string;
  revision_count: number;
  created_at: string;
  rank: number;
}

export interface MemoryContextParams {
  project?: string;
  directory?: string;
  limit?: number;
}

export interface MemoryContextResponse {
  sessions: MemoryContextSession[];
  observations: MemoryContextObservation[];
}

export interface MemoryContextSession {
  id: string;
  project: string;
  directory: string;
  started_at: string;
  ended_at?: string;
  summary?: string;
}

export interface MemoryContextObservation {
  id: number;
  type: string;
  title: string;
  content: string;
  project: string;
  scope: string;
  topic_key: string;
  revision_count: number;
  created_at: string;
  updated_at: string;
}

export interface StartMemorySessionRequest {
  id: string;
  project: string;
  directory: string;
}

export interface EndMemorySessionRequest {
  summary: string;
}

export interface SecretEntry {
  key: string;
}

export interface SetSecretRequest {
  key: string;
  value: string;
}

export class DaemonError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Daemon returned ${status}: ${body}`);
    this.name = "DaemonError";
  }
}

export interface AuditEvent {
  id?: number;
  timestamp?: string;
  session_id?: string;
  task_id?: string;
  agent_id?: string;
  event_type: string;
  tool?: string;
  action?: string;
  target?: string;
  input?: string;
  output?: string;
  success: boolean;
  error_message?: string;
  metadata?: string;
  duration_ms?: number;
}

export interface AuditQueryParams {
  session_id?: string;
  event_type?: string;
  target?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface AuditSummary {
  total_events: number;
  tool_calls: number;
  llm_calls: number;
  file_operations: number;
  command_executions: number;
  errors: number;
}

export type DaemonEventType =
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "trigger.fired"
  | "pr.created"
  | "daily.digest"
  | "cost.warning"
  | "rate_limit.exceeded";

export interface DaemonEvent {
  event_type: string;
  task_id: string;
  task_name: string;
  summary: string;
  details: Record<string, string>;
  timestamp: string;
}

export interface ConfigChange {
  section: string;
  change_type: string;
  detail: string;
}

export interface ConfigReloadResponse {
  status: string;
  cron_triggers: number;
  webhook_triggers: number;
  watcher_triggers: number;
  notification_channels: number;
  changes: ConfigChange[];
}

export interface ConfigValidateResponse {
  valid: boolean;
  errors: string[];
}

export interface EventSubscriptionOptions {
  events?: DaemonEventType[];
  signal?: AbortSignal;
  onEvent: (eventType: string, event: DaemonEvent) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export class DaemonConnectionError extends Error {
  constructor(
    public readonly url: string,
    cause?: unknown,
  ) {
    super(`Could not reach daemon at ${url}`);
    this.name = "DaemonConnectionError";
    this.cause = cause;
  }
}
