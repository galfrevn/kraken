import type {
  AuditEvent,
  AuditQueryParams,
  AuditSummary,
  CleanRequest,
  ConfigReloadResponse,
  ConfigValidateResponse,
  CreateObservationRequest,
  CreateObservationResponse,
  DaemonEvent,
  EndMemorySessionRequest,
  EventSubscriptionOptions,
  MemoryContextParams,
  MemoryContextResponse,
  MemorySearchParams,
  MemorySearchResult,
  Observation,
  RetryTaskRequest,
  ScheduleRequest,
  ScheduleResponse,
  SecretEntry,
  SetSecretRequest,
  StartMemorySessionRequest,
  StatsParams,
  StatsResponse,
  StatusResponse,
  TaskDetails,
  TaskListParams,
  TaskLogEntry,
  TaskResultRequest,
  TaskUsageRequest,
} from "./types.ts";
import { DaemonConnectionError, DaemonError } from "./types.ts";

const DEFAULT_TIMEOUT_MILLISECONDS = 5000;
const TASK_FETCH_TIMEOUT_MILLISECONDS = 10_000;
const MEMORY_SESSION_TIMEOUT_MILLISECONDS = 3000;

interface RequestOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly tasks: TasksApi;
  readonly memory: MemoryApi;
  readonly secrets: SecretsApi;
  readonly audit: AuditApi;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const request = this.request.bind(this);
    this.tasks = new TasksApi(request);
    this.memory = new MemoryApi(request);
    this.secrets = new SecretsApi(request);
    this.audit = new AuditApi(request);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MILLISECONDS;

    try {
      const response = await fetch(url, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: options?.signal ?? AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new DaemonError(response.status, errorBody);
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return (await response.json()) as T;
      }

      return undefined as T;
    } catch (error) {
      if (error instanceof DaemonError) throw error;
      throw new DaemonConnectionError(this.baseUrl, error);
    }
  }

  async health(): Promise<{ status: string }> {
    return this.request("GET", "/api/health");
  }

  async status(): Promise<StatusResponse> {
    return this.request("GET", "/api/status");
  }

  async schedule(data: ScheduleRequest): Promise<ScheduleResponse> {
    return this.request("POST", "/api/schedule", data);
  }

  async stats(params?: StatsParams): Promise<StatsResponse> {
    const query = params?.period ? `?period=${params.period}` : "";
    return this.request("GET", `/api/stats${query}`);
  }

  async clean(data?: CleanRequest): Promise<unknown> {
    return this.request("POST", "/api/clean", data ?? {});
  }

  async config(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/config");
  }

  async configReload(): Promise<ConfigReloadResponse> {
    return this.request("POST", "/api/config/reload");
  }

  async configValidate(): Promise<ConfigValidateResponse> {
    return this.request("POST", "/api/config/validate");
  }

  async shutdown(): Promise<void> {
    return this.request("POST", "/api/shutdown");
  }

  subscribeEvents(options: EventSubscriptionOptions): { unsubscribe: () => void } {
    const abortController = new AbortController();

    const eventFilterQuery = options.events?.length ? `?events=${options.events.join(",")}` : "";

    const connectAndStream = async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/events${eventFilterQuery}`, {
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          options.onError?.(new Error(`SSE connection failed: ${response.status}`));
          return;
        }

        options.onConnect?.();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEventType = "message";

        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const rawEventData = line.slice(6);
              if (!rawEventData) continue;
              try {
                const parsedEvent = JSON.parse(rawEventData) as DaemonEvent;
                options.onEvent(currentEventType, parsedEvent);
              } catch {
                // malformed JSON frame, skip
              }
              currentEventType = "message";
            }
          }
        }
      } catch (connectionError) {
        if (!abortController.signal.aborted) {
          options.onError?.(
            connectionError instanceof Error ? connectionError : new Error(String(connectionError)),
          );
        }
      }

      if (!abortController.signal.aborted) {
        options.onDisconnect?.();
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    connectAndStream().catch((error) => {
      if (!abortController.signal.aborted) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return {
      unsubscribe: () => abortController.abort(),
    };
  }
}

type RequestFn = <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
) => Promise<T>;

class TasksApi {
  constructor(private readonly request: RequestFn) {}

  async get(taskId: string): Promise<TaskDetails> {
    return this.request("GET", `/api/tasks/${taskId}`, undefined, {
      timeout: TASK_FETCH_TIMEOUT_MILLISECONDS,
    });
  }

  async list(params?: TaskListParams): Promise<TaskDetails[]> {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    if (params?.limit !== undefined) searchParams.set("limit", String(params.limit));
    if (params?.offset !== undefined) searchParams.set("offset", String(params.offset));
    const query = searchParams.toString();
    const response = await this.request<{ tasks: TaskDetails[]; total_count: number }>(
      "GET",
      `/api/tasks${query ? `?${query}` : ""}`,
    );
    return response.tasks;
  }

  async cancel(taskId: string): Promise<void> {
    return this.request("POST", `/api/tasks/${taskId}/cancel`);
  }

  async delete(taskId: string): Promise<{ task_id: string; status: string }> {
    return this.request("DELETE", `/api/tasks/${taskId}`);
  }

  async retry(taskId: string, data?: RetryTaskRequest): Promise<void> {
    return this.request("POST", `/api/tasks/${taskId}/retry`, data ?? {});
  }

  async logs(taskId: string): Promise<TaskLogEntry[]> {
    return this.request("GET", `/api/tasks/${taskId}/logs`);
  }

  async heartbeat(taskId: string): Promise<void> {
    return this.request("POST", `/api/tasks/${taskId}/heartbeat`);
  }

  async usage(taskId: string, data: TaskUsageRequest): Promise<void> {
    return this.request("POST", `/api/tasks/${taskId}/usage`, data);
  }

  async result(taskId: string, data: TaskResultRequest): Promise<void> {
    return this.request("POST", `/api/tasks/${taskId}/result`, data);
  }
}

class MemoryApi {
  readonly sessions: MemorySessionsApi;
  readonly observations: MemoryObservationsApi;

  constructor(private readonly request: RequestFn) {
    this.sessions = new MemorySessionsApi(request);
    this.observations = new MemoryObservationsApi(request);
  }

  async search(params: MemorySearchParams): Promise<MemorySearchResult[]> {
    const searchParams = new URLSearchParams();
    searchParams.set("q", params.q);
    if (params.type) searchParams.set("type", params.type);
    if (params.limit !== undefined) searchParams.set("limit", String(params.limit));
    if (params.embedding) searchParams.set("embedding", params.embedding);
    return this.request("GET", `/api/memory/search?${searchParams.toString()}`);
  }

  async context(params?: MemoryContextParams): Promise<MemoryContextResponse> {
    const searchParams = new URLSearchParams();
    if (params?.project) searchParams.set("project", params.project);
    if (params?.directory) searchParams.set("directory", params.directory);
    if (params?.limit !== undefined) searchParams.set("limit", String(params.limit));
    const query = searchParams.toString();
    return this.request("GET", `/api/memory/context${query ? `?${query}` : ""}`);
  }
}

class MemorySessionsApi {
  constructor(private readonly request: RequestFn) {}

  async start(data: StartMemorySessionRequest): Promise<void> {
    return this.request("POST", "/api/memory/sessions", data, {
      timeout: MEMORY_SESSION_TIMEOUT_MILLISECONDS,
    });
  }

  async end(sessionId: string, data: EndMemorySessionRequest): Promise<void> {
    return this.request("POST", `/api/memory/sessions/${sessionId}/end`, data, {
      timeout: MEMORY_SESSION_TIMEOUT_MILLISECONDS,
    });
  }
}

class MemoryObservationsApi {
  constructor(private readonly request: RequestFn) {}

  async create(data: CreateObservationRequest): Promise<CreateObservationResponse> {
    return this.request("POST", "/api/memory/observations", data);
  }

  async get(id: number): Promise<Observation> {
    return this.request("GET", `/api/memory/observations/${id}`);
  }

  async delete(id: number, hard?: boolean): Promise<void> {
    const query = hard ? "?hard=true" : "";
    return this.request("DELETE", `/api/memory/observations/${id}${query}`);
  }
}

class SecretsApi {
  constructor(private readonly request: RequestFn) {}

  async list(): Promise<SecretEntry[]> {
    return this.request("GET", "/api/secrets");
  }

  async set(data: SetSecretRequest): Promise<void> {
    return this.request("POST", "/api/secrets", data);
  }

  async delete(key: string): Promise<void> {
    return this.request("DELETE", `/api/secrets/${key}`);
  }
}

class AuditApi {
  constructor(private readonly request: RequestFn) {}

  async log(event: AuditEvent): Promise<{ id: number }> {
    return this.request("POST", "/api/audit", event);
  }

  async query(params?: AuditQueryParams): Promise<AuditEvent[]> {
    const searchParams = new URLSearchParams();
    if (params?.session_id) searchParams.set("session_id", params.session_id);
    if (params?.event_type) searchParams.set("event_type", params.event_type);
    if (params?.target) searchParams.set("target", params.target);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.limit !== undefined) searchParams.set("limit", String(params.limit));
    if (params?.offset !== undefined) searchParams.set("offset", String(params.offset));
    const query = searchParams.toString();
    const response = await this.request<{ events: AuditEvent[] }>(
      "GET",
      `/api/audit${query ? `?${query}` : ""}`,
    );
    return response.events;
  }

  async session(sessionId: string): Promise<AuditEvent[]> {
    const response = await this.request<{ events: AuditEvent[] }>(
      "GET",
      `/api/audit/session/${sessionId}`,
    );
    return response.events;
  }

  async summary(): Promise<AuditSummary> {
    return this.request("GET", "/api/audit/summary");
  }
}
