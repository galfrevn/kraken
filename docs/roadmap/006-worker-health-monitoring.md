# Worker Health & Resource Monitoring in Rust

## Summary

Expand the daemon's worker management with real-time resource monitoring (CPU, memory, disk I/O per worker process), automatic killing of runaway workers, and a metrics endpoint. The daemon already depends on `sysinfo` — this extends its usage.

## Motivation

Today the orchestrator tracks workers via heartbeats and exit codes, but it doesn't know if a worker is consuming 4GB of RAM or 100% CPU. A stuck LLM streaming call or an infinite loop in a bash tool can consume all system resources without triggering the heartbeat timeout.

## Current State

- `apps/daemon/src/orchestrator/mod.rs`: tracks `WorkerProcess` instances in a `DashMap`, checks heartbeats via `HeartbeatTracker`.
- `apps/daemon/src/orchestrator/worker.rs`: spawns workers as `tokio::process::Command`, stores `Child` handle with PID.
- `apps/daemon/src/orchestrator/heartbeat.rs`: tracks last heartbeat timestamp per task, marks stale after configurable timeout.
- `Cargo.toml` includes `sysinfo = "0.35"` but usage is limited.

## Architecture

### Extend `src/orchestrator/`

```
src/orchestrator/
  mod.rs              -- existing
  worker.rs           -- existing (extend with resource tracking)
  heartbeat.rs        -- existing
  worktree.rs         -- existing
  resource_monitor.rs -- new: periodic resource sampling
```

### Resource Monitor

```rust
pub struct ResourceMonitor {
    system: Mutex<sysinfo::System>,
    worker_metrics: DashMap<u32, WorkerMetrics>,  // PID → metrics
    limits: ResourceLimits,
}

pub struct WorkerMetrics {
    pub pid: u32,
    pub task_id: String,
    pub cpu_usage_percent: f32,
    pub memory_bytes: u64,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    pub started_at: Instant,
    pub samples: Vec<ResourceSample>,   // rolling window of last N samples
}

pub struct ResourceSample {
    pub timestamp: Instant,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

pub struct ResourceLimits {
    pub max_memory_bytes: u64,          // default: 2GB
    pub max_cpu_percent: f32,           // default: 95% sustained
    pub cpu_sustained_seconds: u64,     // default: 300 (5 min)
    pub max_runtime_seconds: u64,       // default: 3600 (1 hour)
    pub max_disk_write_bytes: u64,      // default: 1GB
}
```

### Sampling Loop

```rust
impl ResourceMonitor {
    pub async fn run(&self, mut shutdown: watch::Receiver<bool>) {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                _ = interval.tick() => self.sample_all_workers(),
                _ = shutdown.changed() => break,
            }
        }
    }

    fn sample_all_workers(&self) {
        let mut sys = self.system.lock().unwrap();
        sys.refresh_processes();

        for mut entry in self.worker_metrics.iter_mut() {
            let pid = sysinfo::Pid::from_u32(entry.pid);
            if let Some(process) = sys.process(pid) {
                let sample = ResourceSample {
                    timestamp: Instant::now(),
                    cpu_percent: process.cpu_usage(),
                    memory_bytes: process.memory(),
                };
                entry.samples.push(sample);

                // Keep rolling window of last 60 samples (5 minutes at 5s interval)
                if entry.samples.len() > 60 {
                    entry.samples.remove(0);
                }

                entry.cpu_usage_percent = process.cpu_usage();
                entry.memory_bytes = process.memory();

                // Check limits and kill if exceeded
                self.check_limits(&entry);
            }
        }
    }

    fn check_limits(&self, metrics: &WorkerMetrics) {
        if metrics.memory_bytes > self.limits.max_memory_bytes {
            tracing::warn!("Worker {} (task {}) exceeded memory limit: {} bytes", 
                metrics.pid, metrics.task_id, metrics.memory_bytes);
            self.kill_worker(metrics.pid, "memory limit exceeded");
        }
        // Similar checks for sustained CPU, runtime, disk
    }
}
```

### HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workers` | `GET` | List active workers with current resource usage |
| `/api/workers/{task_id}/metrics` | `GET` | Detailed metrics for a specific worker |
| `/api/metrics` | `GET` | System-wide metrics: total CPU, memory, worker count, queue depth |
| `/api/metrics/history` | `GET` | Historical metrics with `?period=1h&resolution=1m` |

### Integration with Orchestrator

The `ResourceMonitor` is created in `run_daemon()` alongside the orchestrator. When a worker is spawned, the orchestrator registers its PID with the monitor. When a worker exits or is killed, it's deregistered.

```rust
// In orchestrator tick(), after spawning a worker:
resource_monitor.register_worker(worker.pid(), task_id.clone());

// In check_active_workers(), when a worker exits:
resource_monitor.deregister_worker(pid);
```

### Kill Behavior

When a worker exceeds limits:
1. Send `SIGTERM` first, wait 10 seconds.
2. If still alive, send `SIGKILL`.
3. Mark task as failed with exit code `137` (OOM-killed convention).
4. Log the resource metrics at time of kill.
5. Send notification if notifications are configured.

## Configuration

Add to `DaemonConfig` orchestrator section:

```rust
pub struct ResourceLimitsConfig {
    pub max_worker_memory_mb: u64,        // default: 2048
    pub max_worker_cpu_percent: f32,      // default: 95.0
    pub cpu_sustained_seconds: u64,       // default: 300
    pub max_worker_runtime_seconds: u64,  // default: 3600
    pub sample_interval_seconds: u64,     // default: 5
}
```

## Dependencies on Other Roadmap Items

- **Telemetry dashboard** (015): The metrics collected here feed directly into the telemetry system.
- **Web dashboard** (not in roadmap): Can visualize worker metrics in real-time.
