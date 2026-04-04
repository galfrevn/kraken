# Telemetry & Observability Dashboard

## Summary

Collect and expose metrics about the agent's behavior: tokens used per session, cost per task, tool call frequency and latency, success/failure rates, files most modified, model usage breakdown. Store metrics in SQLite and expose via HTTP endpoints. Optionally export to Prometheus/Grafana.

## Motivation

Without telemetry, users can't answer: "How much is Kraken costing me?", "Which tasks fail most often?", "Is the agent getting slower?", "Which tool is called most?". Observability is critical for trust in an autonomous agent.

## Current State

- The daemon tracks basic task stats (`/api/stats`): counts by status, period-based filtering.
- `apps/daemon/src/orchestrator/mod.rs` has cost threshold checking and daily digest notifications.
- The app tracks nothing — no token counting, no latency measurement, no cost estimation.
- No structured telemetry collection exists.

## Architecture

### Metrics Collection Points

#### Daemon Side (Rust)

Already has some stats. Add:

```rust
pub struct DaemonMetrics {
    // Task metrics
    pub tasks_total: AtomicU64,
    pub tasks_succeeded: AtomicU64,
    pub tasks_failed: AtomicU64,
    pub tasks_cancelled: AtomicU64,
    pub task_duration_sum_seconds: AtomicU64,

    // Worker metrics
    pub workers_spawned_total: AtomicU64,
    pub workers_killed_total: AtomicU64,        // OOM, timeout, etc.
    pub worker_peak_memory_bytes: AtomicU64,

    // Trigger metrics
    pub triggers_fired_total: DashMap<String, AtomicU64>,  // by trigger name
    pub webhooks_received_total: AtomicU64,
    pub cron_executions_total: AtomicU64,

    // Cost metrics
    pub total_cost_usd: AtomicU64,              // stored as microdollars
    pub cost_by_model: DashMap<String, AtomicU64>,

    // System metrics (from sysinfo)
    pub daemon_cpu_percent: AtomicU32,
    pub daemon_memory_bytes: AtomicU64,
    pub daemon_uptime_seconds: AtomicU64,
}
```

#### App Side (TypeScript)

Add metrics collection in the session/LLM layer:

```typescript
// metrics/collector.ts
interface SessionMetrics {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  toolCalls: ToolCallMetric[];
  totalDurationMs: number;
  steps: number;
  startedAt: string;
  completedAt: string;
}

interface ToolCallMetric {
  toolId: string;
  durationMs: number;
  inputSize: number;      // size of args
  outputSize: number;     // size of result
  success: boolean;
  timestamp: string;
}
```

Collect in `apps/app/src/session/processor.ts` during stream processing:

```typescript
// After each tool-result part:
metricsCollector.recordToolCall({
  toolId: part.toolName,
  durationMs: part.endTime - part.startTime,
  inputSize: JSON.stringify(part.toolInput).length,
  outputSize: part.content.length,
  success: part.state === "completed",
  timestamp: new Date().toISOString(),
});

// After stream completes:
metricsCollector.recordSession({
  sessionId,
  model: config.model,
  inputTokens: result.usage?.promptTokens ?? 0,
  outputTokens: result.usage?.completionTokens ?? 0,
  estimatedCostUsd: estimateCost(result.usage, config.model),
  toolCalls: collectedToolMetrics,
  totalDurationMs: Date.now() - startTime,
  steps: result.steps?.length ?? 0,
});
```

### Storage

#### SQLite Tables (in daemon DB, via unified storage or separate metrics DB)

```sql
CREATE TABLE metric_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                     -- "session", "tool_call", "task", "trigger"
    data TEXT NOT NULL,                     -- JSON payload
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE metric_aggregates (
    period TEXT NOT NULL,                   -- "hour", "day", "week"
    period_start TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    metadata TEXT,                          -- JSON for breakdowns
    PRIMARY KEY (period, period_start, metric_name)
);

CREATE INDEX idx_metric_events_type ON metric_events(type);
CREATE INDEX idx_metric_events_timestamp ON metric_events(timestamp);
```

### Aggregation

Periodic aggregation (hourly) computes rollups:

```rust
async fn aggregate_metrics(store: &MetricStore) {
    // Hourly aggregates
    let hourly = store.aggregate_since(Duration::from_secs(3600));

    store.save_aggregate("hour", &hourly.period_start, "total_cost_usd", hourly.total_cost);
    store.save_aggregate("hour", &hourly.period_start, "total_tokens", hourly.total_tokens as f64);
    store.save_aggregate("hour", &hourly.period_start, "tool_calls", hourly.tool_call_count as f64);
    store.save_aggregate("hour", &hourly.period_start, "sessions", hourly.session_count as f64);
    store.save_aggregate("hour", &hourly.period_start, "avg_session_duration_ms", hourly.avg_duration);

    // Daily rollup from hourly
    // Weekly rollup from daily
}
```

### HTTP API Endpoints

Add to daemon HTTP API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/metrics` | `GET` | Current metrics snapshot |
| `/api/metrics/sessions` | `GET` | Session-level metrics with `?period=7d&model=*` |
| `/api/metrics/tools` | `GET` | Tool usage breakdown: call count, avg latency, error rate |
| `/api/metrics/costs` | `GET` | Cost breakdown by model, day, task |
| `/api/metrics/costs/forecast` | `GET` | Projected monthly cost based on recent usage |
| `/api/metrics/export` | `GET` | Export raw metrics as JSON/CSV |
| `/api/metrics/prometheus` | `GET` | Prometheus-compatible metrics endpoint |

### Prometheus Export Format

```
# HELP kraken_tasks_total Total tasks processed
# TYPE kraken_tasks_total counter
kraken_tasks_total{status="completed"} 142
kraken_tasks_total{status="failed"} 13
kraken_tasks_total{status="cancelled"} 5

# HELP kraken_cost_usd_total Total estimated cost in USD
# TYPE kraken_cost_usd_total counter
kraken_cost_usd_total{model="claude-sonnet-4"} 3.42
kraken_cost_usd_total{model="claude-haiku-3.5"} 0.18

# HELP kraken_tool_duration_seconds Tool call duration
# TYPE kraken_tool_duration_seconds histogram
kraken_tool_duration_seconds_bucket{tool="bash",le="0.1"} 45
kraken_tool_duration_seconds_bucket{tool="bash",le="1.0"} 120
kraken_tool_duration_seconds_bucket{tool="bash",le="10.0"} 150
```

### CLI Integration

```bash
kraken stats                              # existing, enhanced with new metrics
kraken stats --detailed                   # full breakdown
kraken stats --costs                      # cost-focused view
kraken stats --costs --forecast           # projected monthly cost
kraken stats --tools                      # tool usage analysis
kraken stats --export json > metrics.json # export
```

### Cost Estimation

```typescript
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // per million tokens
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-3.5": { input: 0.80, output: 4.0 },
  "gpt-4o": { input: 2.50, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
};

function estimateCost(usage: TokenUsage, model: string): number {
  const costs = MODEL_COSTS[model];
  if (!costs) return 0;
  return (usage.promptTokens * costs.input + usage.completionTokens * costs.output) / 1_000_000;
}
```

## Configuration

```jsonc
{
  "telemetry": {
    "enabled": true,
    "retentionDays": 90,
    "aggregationIntervalMinutes": 60,
    "prometheusEnabled": false,
    "prometheusPort": 9090
  }
}
```

## Dependencies on Other Roadmap Items

- **Multi-model routing** (011): Per-model cost tracking is essential when using multiple models.
- **Worker health monitoring** (006): System resource metrics feed into the telemetry dashboard.
- **Unified storage** (005): Metrics from both daemon and app in one place.
