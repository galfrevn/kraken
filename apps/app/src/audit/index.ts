import type { AuditEvent } from "@kraken/sdk";
import { getDaemon } from "@/daemon/client.ts";

const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[=:]\s*\S+/gi,
  /(?:sk|pk|rk|ghp|gho|ghs|github_pat)_[a-zA-Z0-9_-]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
];

const MAX_CONTENT_BYTES = 10_240;

function redactSensitiveContent(content: string): string {
  let redacted = content;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_BYTES) return content;
  return content.slice(0, MAX_CONTENT_BYTES) + "...(truncated)";
}

function sanitize(content: string | undefined): string | undefined {
  if (!content) return content;
  return truncateContent(redactSensitiveContent(content));
}

const TOOL_EVENT_TYPE_MAP: Record<string, string> = {
  read: "file_read",
  write: "file_write",
  edit: "file_edit",
  bash: "command_execute",
  grep: "search",
  glob: "search",
  schedule_task: "task_schedule",
  memory_save: "memory_write",
  websearch: "api_call",
  webfetch: "api_call",
};

function mapToolToEventType(toolId: string): string {
  return TOOL_EVENT_TYPE_MAP[toolId] ?? "tool_call";
}

export async function logToolCall(params: {
  sessionId: string;
  toolId: string;
  args: unknown;
  result: unknown;
  success: boolean;
  errorMessage?: string;
  durationMs: number;
}): Promise<void> {
  const argsString = typeof params.args === "string" ? params.args : JSON.stringify(params.args);
  const resultString =
    typeof params.result === "string" ? params.result : JSON.stringify(params.result);

  const event: AuditEvent = {
    session_id: params.sessionId,
    event_type: mapToolToEventType(params.toolId),
    tool: params.toolId,
    action: "execute",
    input: sanitize(argsString),
    output: sanitize(resultString),
    success: params.success,
    error_message: params.errorMessage,
    duration_ms: params.durationMs,
  };

  try {
    await getDaemon().audit.log(event);
  } catch {
    // audit logging is best-effort
  }
}

export async function logLlmCall(params: {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
}): Promise<void> {
  const event: AuditEvent = {
    session_id: params.sessionId,
    event_type: "llm_call",
    action: "stream",
    success: true,
    metadata: JSON.stringify({
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      total_tokens: params.totalTokens,
      model: params.model,
    }),
  };

  try {
    await getDaemon().audit.log(event);
  } catch {
    // audit logging is best-effort
  }
}
