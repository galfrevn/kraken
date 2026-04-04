use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{delete, get, post};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tracing::{error, info};

use crate::daemon::config::DaemonConfig;
use crate::daemon::reload::ReloadHandle;
use crate::db::audit::{AuditEvent, AuditQueryParams, AuditStore};
use crate::db::memory::MemoryStore;
use crate::db::tasks::TaskStore;
use crate::events::{DaemonEvent, DaemonEventType, EventBroadcaster};
use crate::memory_api::{self, MemoryApiState};
use crate::orchestrator::heartbeat::HeartbeatTracker;
use crate::rate_limiter::LoopDetector;

const DEFAULT_TASK_LIST_LIMIT: i32 = 20;
const MAX_TASK_LIST_LIMIT: i32 = 500;
const DEFAULT_TASK_PRIORITY: i32 = 5;
const DEFAULT_TASK_AGENT: &str = "build";
const STATS_PERIOD_WEEK_DAYS: i32 = 7;
const STATS_PERIOD_MONTH_DAYS: i32 = 30;

#[derive(Clone)]
struct HttpApiState {
    task_store: Arc<TaskStore>,
    shutdown_sender: Option<Arc<watch::Sender<bool>>>,
    active_worker_count: Option<Arc<AtomicU32>>,
    max_concurrent_workers: u32,
    daemon_start_time: Option<std::time::Instant>,
    daemon_port: u16,
    config_path: Option<String>,
    heartbeat_tracker: Option<Arc<HeartbeatTracker>>,
    event_broadcaster: Option<EventBroadcaster>,
    audit_store: Option<Arc<AuditStore>>,
    loop_detector: Option<Arc<LoopDetector>>,
    reload_handle: Option<Arc<ReloadHandle>>,
    widget_token: Option<String>,
}

#[derive(Deserialize)]
struct ScheduleTaskRequestBody {
    prompt: String,
    priority: Option<i32>,
    agent: Option<String>,
    workdir: Option<String>,
    run_at: Option<String>,
    cron_expression: Option<String>,
    repeat_interval_seconds: Option<i64>,
    channel_type: Option<String>,
    channel_chat_id: Option<String>,
}

#[derive(Deserialize)]
struct ListTasksQueryParameters {
    status: Option<String>,
    limit: Option<i32>,
    offset: Option<i32>,
}

#[derive(Deserialize)]
struct RetryTaskRequestBody {
    agent: Option<String>,
}

#[derive(Deserialize)]
struct StatsQueryParameters {
    period: Option<String>,
}

#[derive(Deserialize)]
struct EventStreamQueryParameters {
    events: Option<String>,
}

#[derive(Deserialize)]
struct CleanRequestBody {
    #[allow(dead_code)]
    worktrees: bool,
    task_days: Option<u32>,
    dry_run: bool,
}

#[allow(dead_code)]
pub async fn start_http_api_server(
    task_store: Arc<TaskStore>,
    http_api_port: u16,
    shutdown_signal_receiver: watch::Receiver<bool>,
) -> Result<(), String> {
    start_http_api_server_with_options(
        task_store,
        http_api_port,
        shutdown_signal_receiver.clone(),
        None,
        None,
        0,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await?;

    let _ = shutdown_signal_receiver;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn start_http_api_server_with_options(
    task_store: Arc<TaskStore>,
    http_api_port: u16,
    mut shutdown_signal_receiver: watch::Receiver<bool>,
    shutdown_sender: Option<Arc<watch::Sender<bool>>>,
    active_worker_count: Option<Arc<AtomicU32>>,
    max_concurrent_workers: u32,
    daemon_start_time: Option<std::time::Instant>,
    config_path: Option<String>,
    heartbeat_tracker: Option<Arc<HeartbeatTracker>>,
    memory_store: Option<Arc<MemoryStore>>,
    event_broadcaster: Option<EventBroadcaster>,
    audit_store: Option<Arc<AuditStore>>,
    loop_detector: Option<Arc<LoopDetector>>,
    reload_handle: Option<Arc<ReloadHandle>>,
    widget_token: Option<String>,
) -> Result<(), String> {
    let http_api_state = HttpApiState {
        task_store,
        shutdown_sender,
        active_worker_count,
        max_concurrent_workers,
        daemon_start_time,
        daemon_port: http_api_port,
        config_path,
        heartbeat_tracker,
        event_broadcaster,
        audit_store,
        loop_detector,
        reload_handle,
        widget_token,
    };

    let mut http_api_router = Router::new()
        .route("/api/schedule", post(handle_schedule_task_request))
        .route("/api/health", get(handle_health_check_request))
        .route("/api/widget", get(handle_widget_request))
        .route("/api/status", get(handle_status_request))
        .route("/api/shutdown", post(handle_shutdown_request))
        .route("/api/tasks", get(handle_list_tasks_request))
        .route(
            "/api/tasks/{task_id}",
            get(handle_get_task_request).delete(handle_delete_task_request),
        )
        .route(
            "/api/tasks/{task_id}/cancel",
            post(handle_cancel_task_request),
        )
        .route(
            "/api/tasks/{task_id}/retry",
            post(handle_retry_task_request),
        )
        .route(
            "/api/tasks/{task_id}/logs",
            get(handle_get_task_logs_request),
        )
        .route("/api/stats", get(handle_stats_request))
        .route("/api/clean", post(handle_clean_request))
        .route("/api/config", get(handle_get_config_request))
        .route("/api/config/reload", post(handle_config_reload_request))
        .route("/api/config/validate", post(handle_config_validate_request))
        .route(
            "/api/tasks/{task_id}/usage",
            post(handle_report_usage_request),
        )
        .route(
            "/api/tasks/{task_id}/heartbeat",
            post(handle_heartbeat_request),
        )
        .route(
            "/api/tasks/{task_id}/result",
            post(handle_worker_result_request),
        )
        .route("/api/secrets", get(handle_list_secrets_request))
        .route("/api/secrets", post(handle_set_secret_request))
        .route("/api/secrets/{key}", delete(handle_delete_secret_request))
        .route("/api/events", get(handle_event_stream_request))
        .route(
            "/api/audit",
            post(handle_insert_audit_event).get(handle_query_audit_events),
        )
        .route(
            "/api/audit/session/{session_id}",
            get(handle_audit_by_session),
        )
        .route("/api/audit/summary", get(handle_audit_summary))
        .route("/api/pairing", get(handle_list_pairing_requests))
        .route("/api/pairing/approve", post(handle_approve_pairing))
        .route("/api/pairing/reject", post(handle_reject_pairing))
        .route("/api/users", get(handle_list_users).post(handle_add_user))
        .route(
            "/api/users/{channel}/{platform_id}",
            delete(handle_remove_user),
        )
        .route("/api/channels/send", post(handle_channel_send))
        .route("/api/channels/sessions", get(handle_channel_sessions))
        .with_state(http_api_state);

    if let Some(memory_store) = memory_store {
        let memory_state = MemoryApiState { memory_store };
        http_api_router =
            http_api_router.merge(memory_api::memory_routes().with_state(memory_state));
    }

    let listen_address = format!("127.0.0.1:{http_api_port}");
    let tcp_listener = TcpListener::bind(&listen_address)
        .await
        .map_err(|bind_error| {
            format!("failed to bind HTTP API server on {listen_address}: {bind_error}")
        })?;

    info!(port = http_api_port, "HTTP API server starting");

    axum::serve(tcp_listener, http_api_router)
        .with_graceful_shutdown(async move {
            let _ = shutdown_signal_receiver.changed().await;
        })
        .await
        .map_err(|serve_error| format!("HTTP API server error: {serve_error}"))?;

    info!("HTTP API server stopped");
    Ok(())
}

async fn handle_schedule_task_request(
    State(http_api_state): State<HttpApiState>,
    axum::Json(request_body): axum::Json<ScheduleTaskRequestBody>,
) -> impl IntoResponse {
    if request_body.prompt.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "prompt must not be empty" })),
        );
    }

    if let Some(ref detector) = http_api_state.loop_detector
        && detector.check_loop(&request_body.prompt)
    {
        if let Some(ref broadcaster) = http_api_state.event_broadcaster {
            let mut details = std::collections::HashMap::new();
            details.insert("reason".to_string(), "loop_detected".to_string());
            details.insert(
                "prompt_preview".to_string(),
                request_body.prompt.chars().take(100).collect(),
            );
            broadcaster.publish(DaemonEvent {
                event_type: DaemonEventType::RateLimitExceeded,
                task_id: String::new(),
                task_name: String::new(),
                summary: "Loop detected: same prompt scheduled too many times in the window"
                    .to_string(),
                details,
                timestamp: chrono::Utc::now(),
            });
        }

        return (
            StatusCode::TOO_MANY_REQUESTS,
            axum::Json(json!({
                "error": "loop detected: this prompt has been scheduled too many times recently"
            })),
        );
    }

    let task_name = if request_body.prompt.len() > 60 {
        format!("{}...", &request_body.prompt[..57])
    } else {
        request_body.prompt.clone()
    };

    let task_priority = request_body.priority.unwrap_or(DEFAULT_TASK_PRIORITY);
    let task_agent = request_body.agent.as_deref().unwrap_or(DEFAULT_TASK_AGENT);

    match http_api_state
        .task_store
        .create_task_with_schedule(
            &task_name,
            &request_body.prompt,
            task_priority,
            task_agent,
            request_body.workdir.as_deref(),
            request_body.run_at.as_deref(),
            request_body.cron_expression.as_deref(),
            request_body.repeat_interval_seconds,
            request_body.channel_type.as_deref(),
            request_body.channel_chat_id.as_deref(),
        )
        .await
    {
        Ok(created_task) => {
            info!(
                task_id = %created_task.id,
                task_name = %created_task.name,
                "task scheduled via HTTP API"
            );

            (
                StatusCode::CREATED,
                axum::Json(json!({
                    "task_id": created_task.id,
                    "status": "scheduled"
                })),
            )
        }
        Err(task_creation_error) => {
            error!(
                error = %task_creation_error,
                "failed to create scheduled task via HTTP API"
            );

            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({
                    "error": task_creation_error
                })),
            )
        }
    }
}

#[derive(Deserialize)]
struct WidgetQueryParameters {
    token: Option<String>,
}

async fn handle_widget_request(
    State(http_api_state): State<HttpApiState>,
    Query(params): Query<WidgetQueryParameters>,
) -> impl IntoResponse {
    if let Some(ref expected_token) = http_api_state.widget_token {
        match &params.token {
            Some(provided) if provided == expected_token => {}
            _ => {
                return (
                    StatusCode::UNAUTHORIZED,
                    axum::Json(json!({ "error": "invalid or missing token" })),
                );
            }
        }
    } else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": "widget not enabled" })),
        );
    }

    let uptime_seconds = http_api_state
        .daemon_start_time
        .map(|start| start.elapsed().as_secs())
        .unwrap_or(0);

    let active_workers = http_api_state
        .active_worker_count
        .as_ref()
        .map(|c| c.load(Ordering::Relaxed))
        .unwrap_or(0);

    let pending = http_api_state.task_store.count_by_status("pending").await;
    let running = http_api_state.task_store.count_by_status("running").await;
    let completed = http_api_state.task_store.count_by_status("completed").await;
    let failed = http_api_state.task_store.count_by_status("failed").await;

    let (recent_tasks, _) = http_api_state
        .task_store
        .list_tasks(Some("completed"), 3, 0)
        .await;

    let recent: Vec<serde_json::Value> = recent_tasks
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "status": t.status,
                "cost": format!("${:.4}", t.estimated_cost_usd),
                "completed_at": t.completed_at,
            })
        })
        .collect();

    (
        StatusCode::OK,
        axum::Json(json!({
            "daemon": "online",
            "uptime_seconds": uptime_seconds,
            "workers": { "active": active_workers, "max": http_api_state.max_concurrent_workers },
            "tasks": { "pending": pending, "running": running, "completed": completed, "failed": failed },
            "recent": recent,
        })),
    )
}

async fn handle_health_check_request() -> impl IntoResponse {
    (StatusCode::OK, axum::Json(json!({ "status": "ok" })))
}

async fn handle_status_request(State(http_api_state): State<HttpApiState>) -> impl IntoResponse {
    let current_process_pid = std::process::id();

    let uptime_seconds = http_api_state
        .daemon_start_time
        .map(|start_instant| start_instant.elapsed().as_secs());

    let active_worker_count_value = http_api_state
        .active_worker_count
        .as_ref()
        .map(|counter| counter.load(Ordering::Relaxed));

    let workers_json = active_worker_count_value.map(|active_count| {
        json!({
            "active": active_count,
            "max": http_api_state.max_concurrent_workers
        })
    });

    let pending_task_count = http_api_state.task_store.count_by_status("pending").await;
    let running_task_count = http_api_state.task_store.count_by_status("running").await;
    let completed_task_count = http_api_state.task_store.count_by_status("completed").await;
    let failed_task_count = http_api_state.task_store.count_by_status("failed").await;

    let tasks_json = json!({
        "pending": pending_task_count,
        "running": running_task_count,
        "completed": completed_task_count,
        "failed": failed_task_count
    });

    (
        StatusCode::OK,
        axum::Json(json!({
            "running": true,
            "pid": current_process_pid,
            "uptime_seconds": uptime_seconds,
            "port": http_api_state.daemon_port,
            "workers": workers_json,
            "tasks": tasks_json,
            "config_path": http_api_state.config_path
        })),
    )
}

async fn handle_shutdown_request(State(http_api_state): State<HttpApiState>) -> impl IntoResponse {
    if let Some(ref shutdown_sender) = http_api_state.shutdown_sender {
        let _ = shutdown_sender.send(true);
        info!("graceful shutdown triggered via HTTP API /api/shutdown");
        (
            StatusCode::OK,
            axum::Json(json!({ "status": "shutting_down" })),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": "shutdown channel not available" })),
        )
    }
}

async fn handle_list_tasks_request(
    State(http_api_state): State<HttpApiState>,
    Query(query_parameters): Query<ListTasksQueryParameters>,
) -> impl IntoResponse {
    let list_limit = query_parameters
        .limit
        .unwrap_or(DEFAULT_TASK_LIST_LIMIT)
        .clamp(0, MAX_TASK_LIST_LIMIT);
    let list_offset = query_parameters.offset.unwrap_or(0).max(0);
    let status_filter = query_parameters
        .status
        .as_deref()
        .filter(|s| !s.eq_ignore_ascii_case("all"));

    let (matching_tasks, total_task_count) = http_api_state
        .task_store
        .list_tasks(status_filter, list_limit, list_offset)
        .await;

    let tasks_json: Vec<serde_json::Value> = matching_tasks
        .iter()
        .map(|task| {
            json!({
                "id": task.id,
                "name": task.name,
                "description": task.description,
                "prompt": task.description,
                "status": task.status,
                "priority": task.priority,
                "agent": task.agent,
                "attempt": task.attempt,
                "started_at": task.started_at,
                "completed_at": task.completed_at,
                "created_at": task.created_at,
                "exit_code": task.exit_code,
                "error_message": task.error_message,
                "prompt_tokens": task.prompt_tokens,
                "completion_tokens": task.completion_tokens,
                "estimated_cost_usd": task.estimated_cost_usd,
            })
        })
        .collect();

    (
        StatusCode::OK,
        axum::Json(json!({
            "tasks": tasks_json,
            "total_count": total_task_count
        })),
    )
}

async fn handle_get_task_request(
    State(http_api_state): State<HttpApiState>,
    Path(task_id_or_prefix): Path<String>,
) -> impl IntoResponse {
    let resolved_task = match http_api_state.task_store.get_task(&task_id_or_prefix).await {
        Some(exact_match_task) => Ok(exact_match_task),
        None => {
            http_api_state
                .task_store
                .find_by_prefix(&task_id_or_prefix)
                .await
        }
    };

    match resolved_task {
        Ok(task) => (
            StatusCode::OK,
            axum::Json(json!({
                "id": task.id,
                "name": task.name,
                "description": task.description,
                "status": task.status,
                "priority": task.priority,
                "agent": task.agent,
                "trigger_id": task.trigger_id,
                "trigger_type": task.trigger_type,
                "trigger_payload": task.trigger_payload,
                "worker_pid": task.worker_pid,
                "worker_dir": task.worker_dir,
                "started_at": task.started_at,
                "completed_at": task.completed_at,
                "updated_at": task.updated_at,
                "timeout_ms": task.timeout_ms,
                "exit_code": task.exit_code,
                "output": task.output,
                "error_message": task.error_message,
                "artifacts": task.artifacts,
                "prompt_tokens": task.prompt_tokens,
                "completion_tokens": task.completion_tokens,
                "estimated_cost_usd": task.estimated_cost_usd,
                "attempt": task.attempt,
                "max_retries": task.max_retries,
                "created_at": task.created_at,
            })),
        ),
        Err(lookup_error) => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": lookup_error })),
        ),
    }
}

async fn handle_cancel_task_request(
    State(http_api_state): State<HttpApiState>,
    Path(task_id_or_prefix): Path<String>,
) -> impl IntoResponse {
    let resolved_task = match http_api_state.task_store.get_task(&task_id_or_prefix).await {
        Some(exact_match_task) => Ok(exact_match_task),
        None => {
            http_api_state
                .task_store
                .find_by_prefix(&task_id_or_prefix)
                .await
        }
    };

    let task = match resolved_task {
        Ok(found_task) => found_task,
        Err(lookup_error) => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({ "error": lookup_error })),
            );
        }
    };

    match task.status.as_str() {
        "completed" | "failed" | "cancelled" => {
            return (
                StatusCode::CONFLICT,
                axum::Json(json!({
                    "error": format!("task is already in terminal state: {}", task.status)
                })),
            );
        }
        _ => {}
    }

    match http_api_state
        .task_store
        .update_status(&task.id, "cancelled")
        .await
    {
        Ok(()) => {
            info!(task_id = %task.id, "task cancelled via HTTP API");
            (
                StatusCode::OK,
                axum::Json(json!({
                    "task_id": task.id,
                    "status": "cancelled"
                })),
            )
        }
        Err(cancellation_error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": cancellation_error })),
        ),
    }
}

async fn handle_delete_task_request(
    State(http_api_state): State<HttpApiState>,
    Path(task_id_or_prefix): Path<String>,
) -> impl IntoResponse {
    let resolved_task = match http_api_state.task_store.get_task(&task_id_or_prefix).await {
        Some(exact_match_task) => Ok(exact_match_task),
        None => {
            http_api_state
                .task_store
                .find_by_prefix(&task_id_or_prefix)
                .await
        }
    };

    let task = match resolved_task {
        Ok(found_task) => found_task,
        Err(lookup_error) => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({ "error": lookup_error })),
            );
        }
    };

    match http_api_state.task_store.delete_task(&task.id).await {
        Ok(()) => {
            info!(task_id = %task.id, "task deleted via HTTP API");
            (
                StatusCode::OK,
                axum::Json(json!({
                    "task_id": task.id,
                    "status": "deleted"
                })),
            )
        }
        Err(deletion_error) => {
            let status_code = if deletion_error.contains("can only delete") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status_code, axum::Json(json!({ "error": deletion_error })))
        }
    }
}

async fn handle_retry_task_request(
    State(http_api_state): State<HttpApiState>,
    Path(task_id_or_prefix): Path<String>,
    retry_body: Option<axum::Json<RetryTaskRequestBody>>,
) -> impl IntoResponse {
    let resolved_task = match http_api_state.task_store.get_task(&task_id_or_prefix).await {
        Some(exact_match_task) => Ok(exact_match_task),
        None => {
            http_api_state
                .task_store
                .find_by_prefix(&task_id_or_prefix)
                .await
        }
    };

    let task = match resolved_task {
        Ok(found_task) => found_task,
        Err(lookup_error) => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({ "error": lookup_error })),
            );
        }
    };

    match task.status.as_str() {
        "failed" | "cancelled" => { /* allowed */ }
        _ => {
            return (
                StatusCode::CONFLICT,
                axum::Json(json!({
                    "error": format!("task is not in a terminal state (current: {}), cannot retry", task.status)
                })),
            );
        }
    }

    if let Err(increment_error) = http_api_state.task_store.increment_attempt(&task.id).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": increment_error })),
        );
    }

    if let Err(status_update_error) = http_api_state
        .task_store
        .update_status(&task.id, "pending")
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": status_update_error })),
        );
    }

    if let Some(requested_agent) = retry_body.as_ref().and_then(|body| body.agent.as_deref())
        && let Err(agent_update_error) = http_api_state
            .task_store
            .update_agent(&task.id, requested_agent)
            .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": agent_update_error })),
        );
    }

    info!(task_id = %task.id, "task retried via HTTP API");

    (
        StatusCode::OK,
        axum::Json(json!({
            "task_id": task.id,
            "status": "pending",
            "attempt": task.attempt + 1
        })),
    )
}

async fn handle_get_task_logs_request(
    State(http_api_state): State<HttpApiState>,
    Path(task_id_or_prefix): Path<String>,
) -> impl IntoResponse {
    let resolved_task = match http_api_state.task_store.get_task(&task_id_or_prefix).await {
        Some(exact_match_task) => Ok(exact_match_task),
        None => {
            http_api_state
                .task_store
                .find_by_prefix(&task_id_or_prefix)
                .await
        }
    };

    let task = match resolved_task {
        Ok(found_task) => found_task,
        Err(lookup_error) => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({ "error": lookup_error })),
            );
        }
    };

    let raw_log_entries = http_api_state.task_store.get_task_logs(&task.id).await;

    let log_entries_json: Vec<serde_json::Value> = raw_log_entries
        .iter()
        .map(|(level, message, timestamp)| {
            json!({
                "timestamp": timestamp,
                "level": level,
                "message": message,
            })
        })
        .collect();

    (
        StatusCode::OK,
        axum::Json(json!({ "logs": log_entries_json })),
    )
}

async fn handle_stats_request(
    State(http_api_state): State<HttpApiState>,
    Query(query_parameters): Query<StatsQueryParameters>,
) -> impl IntoResponse {
    let period_label = query_parameters.period.as_deref().unwrap_or("today");

    let days_back = match period_label {
        "week" => STATS_PERIOD_WEEK_DAYS,
        "month" => STATS_PERIOD_MONTH_DAYS,
        _ => 0, // default to today
    };

    let period_statistics = http_api_state
        .task_store
        .get_statistics_for_period(days_back)
        .await;

    let pending_task_count = http_api_state.task_store.count_by_status("pending").await;
    let running_task_count = http_api_state.task_store.count_by_status("running").await;

    (
        StatusCode::OK,
        axum::Json(json!({
            "completed": period_statistics.completed_task_count,
            "failed": period_statistics.failed_task_count,
            "pending": pending_task_count,
            "running": running_task_count,
            "prompt_tokens": period_statistics.total_prompt_tokens,
            "completion_tokens": period_statistics.total_completion_tokens,
            "cost_usd": period_statistics.total_cost_usd,
        })),
    )
}

async fn handle_clean_request(
    State(http_api_state): State<HttpApiState>,
    axum::Json(request_body): axum::Json<CleanRequestBody>,
) -> impl IntoResponse {
    let mut tasks_removed_count = 0i32;

    if let Some(task_age_days) = request_body.task_days {
        if !request_body.dry_run {
            tasks_removed_count = http_api_state
                .task_store
                .delete_old_tasks(task_age_days)
                .await;
        } else {
            tasks_removed_count = http_api_state
                .task_store
                .count_old_tasks(task_age_days)
                .await;
        }
    }

    // Worktree cleanup requires orchestrator access; return 0 for now
    let worktrees_removed_count = 0i32;

    (
        StatusCode::OK,
        axum::Json(json!({
            "worktrees_removed": worktrees_removed_count,
            "tasks_removed": tasks_removed_count,
        })),
    )
}

async fn handle_heartbeat_request(
    State(http_api_state): State<HttpApiState>,
    Path(task_id): Path<String>,
) -> impl IntoResponse {
    if let Some(ref tracker) = http_api_state.heartbeat_tracker {
        tracker.record_heartbeat(&task_id);
        (StatusCode::OK, axum::Json(json!({ "status": "ok" })))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": "heartbeat tracker not available" })),
        )
    }
}

#[derive(Deserialize)]
struct WorkerResultRequestBody {
    output: Option<String>,
    #[serde(default)]
    exit_code: Option<i32>,
}

async fn handle_worker_result_request(
    State(http_api_state): State<HttpApiState>,
    Path(task_id_or_prefix): Path<String>,
    axum::Json(request_body): axum::Json<WorkerResultRequestBody>,
) -> impl IntoResponse {
    let resolved_task = match http_api_state.task_store.get_task(&task_id_or_prefix).await {
        Some(task) => Ok(task),
        None => {
            http_api_state
                .task_store
                .find_by_prefix(&task_id_or_prefix)
                .await
        }
    };

    let task = match resolved_task {
        Ok(found_task) => found_task,
        Err(lookup_error) => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({ "error": lookup_error })),
            );
        }
    };

    let worker_exit_code = request_body.exit_code.unwrap_or(0);

    if let Err(update_error) = http_api_state
        .task_store
        .update_result(
            &task.id,
            worker_exit_code,
            request_body.output.as_deref(),
            None,
            None,
        )
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": update_error })),
        );
    }

    (
        StatusCode::OK,
        axum::Json(json!({ "task_id": task.id, "status": "output_saved" })),
    )
}

fn redact_sensitive_json_value(value: &mut serde_json::Value) {
    const SENSITIVE_SUBSTRINGS: &[&str] = &["key", "secret", "token", "password"];

    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                let key_lower = key.to_lowercase();
                let is_sensitive = SENSITIVE_SUBSTRINGS
                    .iter()
                    .any(|substr| key_lower.contains(substr));

                if is_sensitive {
                    match child {
                        serde_json::Value::String(s) if !s.is_empty() => {
                            *child = serde_json::Value::String("****".to_string());
                        }
                        serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                            redact_sensitive_json_value(child);
                        }
                        _ => {}
                    }
                } else {
                    redact_sensitive_json_value(child);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                redact_sensitive_json_value(item);
            }
        }
        _ => {}
    }
}

async fn handle_get_config_request(
    State(http_api_state): State<HttpApiState>,
) -> impl IntoResponse {
    let config_path = http_api_state
        .config_path
        .as_deref()
        .map(std::path::Path::new);

    match DaemonConfig::load(config_path) {
        Ok(config) => {
            let mut config_json = serde_json::to_value(&config).unwrap_or(json!({}));
            redact_sensitive_json_value(&mut config_json);
            (StatusCode::OK, axum::Json(config_json))
        }
        Err(config_error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": format!("failed to load config: {config_error}") })),
        ),
    }
}

async fn handle_config_reload_request(
    State(http_api_state): State<HttpApiState>,
) -> impl IntoResponse {
    let Some(ref reload_handle) = http_api_state.reload_handle else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": "reload not available" })),
        );
    };

    match reload_handle.reload().await {
        Ok((result, changes)) => (
            StatusCode::OK,
            axum::Json(json!({
                "status": "reloaded",
                "cron_triggers": result.cron_trigger_count,
                "webhook_triggers": result.webhook_trigger_count,
                "watcher_triggers": result.watcher_trigger_count,
                "notification_channels": result.notification_channel_count,
                "changes": changes,
            })),
        ),
        Err(reload_error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": reload_error })),
        ),
    }
}

async fn handle_config_validate_request(
    State(http_api_state): State<HttpApiState>,
) -> impl IntoResponse {
    let config_path = http_api_state
        .config_path
        .as_deref()
        .map(std::path::Path::new);

    let config = match DaemonConfig::load(config_path) {
        Ok(c) => c,
        Err(parse_error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({
                    "valid": false,
                    "errors": [format!("parse error: {parse_error}")]
                })),
            );
        }
    };

    match config.validate() {
        Ok(()) => {
            let empty: Vec<String> = Vec::new();
            (
                StatusCode::OK,
                axum::Json(json!({ "valid": true, "errors": empty })),
            )
        }
        Err(validation_errors) => (
            StatusCode::OK,
            axum::Json(json!({ "valid": false, "errors": validation_errors })),
        ),
    }
}

#[derive(Deserialize)]
struct ReportUsageRequestBody {
    prompt_tokens: i64,
    completion_tokens: i64,
    #[serde(default)]
    cost_usd: f64,
}

async fn handle_report_usage_request(
    State(http_api_state): State<HttpApiState>,
    Path(task_id_or_prefix): Path<String>,
    axum::Json(request_body): axum::Json<ReportUsageRequestBody>,
) -> impl IntoResponse {
    if request_body.prompt_tokens < 0 || request_body.completion_tokens < 0 {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "token counts must not be negative" })),
        );
    }

    if request_body.cost_usd.is_nan()
        || request_body.cost_usd.is_infinite()
        || request_body.cost_usd < 0.0
    {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "cost_usd must be a non-negative finite number" })),
        );
    }

    let resolved_task = match http_api_state.task_store.get_task(&task_id_or_prefix).await {
        Some(exact_match_task) => Ok(exact_match_task),
        None => {
            http_api_state
                .task_store
                .find_by_prefix(&task_id_or_prefix)
                .await
        }
    };

    let task = match resolved_task {
        Ok(found_task) => found_task,
        Err(lookup_error) => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({ "error": lookup_error })),
            );
        }
    };

    match http_api_state
        .task_store
        .add_token_usage(
            &task.id,
            request_body.prompt_tokens,
            request_body.completion_tokens,
            request_body.cost_usd,
        )
        .await
    {
        Ok(()) => (
            StatusCode::OK,
            axum::Json(json!({
                "task_id": task.id,
                "status": "usage_recorded"
            })),
        ),
        Err(usage_error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": usage_error })),
        ),
    }
}

#[derive(Deserialize)]
struct SetSecretRequestBody {
    key: String,
    value: String,
}

fn resolve_env_file_path() -> std::path::PathBuf {
    let home_directory = dirs_next::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home_directory.join(".kraken").join(".env")
}

fn read_env_file_entries(env_file_path: &std::path::Path) -> Vec<(String, String)> {
    let contents = match std::fs::read_to_string(env_file_path) {
        Ok(contents) => contents,
        Err(_) => return Vec::new(),
    };

    contents
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let (key, value) = trimmed.split_once('=')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn write_env_file_entries(
    env_file_path: &std::path::Path,
    entries: &[(String, String)],
) -> Result<(), String> {
    if let Some(parent_directory) = env_file_path.parent() {
        std::fs::create_dir_all(parent_directory)
            .map_err(|error| format!("failed to create directory: {error}"))?;
    }

    let file_contents = entries
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\n");

    std::fs::write(env_file_path, file_contents + "\n")
        .map_err(|error| format!("failed to write env file: {error}"))
}

async fn handle_list_secrets_request() -> impl IntoResponse {
    let env_file_path = resolve_env_file_path();
    let entries = read_env_file_entries(&env_file_path);
    let key_names: Vec<&str> = entries.iter().map(|(key, _)| key.as_str()).collect();

    (StatusCode::OK, axum::Json(json!({ "keys": key_names })))
}

fn is_valid_env_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 256
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

async fn handle_set_secret_request(
    axum::Json(request_body): axum::Json<SetSecretRequestBody>,
) -> impl IntoResponse {
    if !is_valid_env_key(&request_body.key) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(
                json!({ "error": "key must be non-empty, max 256 chars, alphanumeric or underscore only" }),
            ),
        );
    }

    if request_body.value.contains('\n') || request_body.value.contains('\r') {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "value must not contain newlines" })),
        );
    }

    let env_file_path = resolve_env_file_path();
    let mut entries = read_env_file_entries(&env_file_path);

    if let Some(existing_entry) = entries.iter_mut().find(|(key, _)| *key == request_body.key) {
        existing_entry.1 = request_body.value;
    } else {
        entries.push((request_body.key.clone(), request_body.value));
    }

    match write_env_file_entries(&env_file_path, &entries) {
        Ok(()) => {
            info!(key = %request_body.key, "secret updated via API");
            (
                StatusCode::OK,
                axum::Json(json!({ "key": request_body.key, "status": "saved" })),
            )
        }
        Err(write_error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": write_error })),
        ),
    }
}

async fn handle_delete_secret_request(Path(key): Path<String>) -> impl IntoResponse {
    if !is_valid_env_key(&key) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "invalid key format" })),
        );
    }

    let env_file_path = resolve_env_file_path();
    let entries = read_env_file_entries(&env_file_path);

    let original_count = entries.len();
    let filtered_entries: Vec<(String, String)> = entries
        .into_iter()
        .filter(|(entry_key, _)| *entry_key != key)
        .collect();

    if filtered_entries.len() == original_count {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": format!("key '{key}' not found") })),
        );
    }

    match write_env_file_entries(&env_file_path, &filtered_entries) {
        Ok(()) => {
            info!(key = %key, "secret deleted via API");
            (
                StatusCode::OK,
                axum::Json(json!({ "key": key, "status": "deleted" })),
            )
        }
        Err(write_error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": write_error })),
        ),
    }
}

async fn handle_insert_audit_event(
    State(http_api_state): State<HttpApiState>,
    axum::Json(event): axum::Json<AuditEvent>,
) -> impl IntoResponse {
    let Some(ref audit_store) = http_api_state.audit_store else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": "audit store not available" })),
        );
    };

    match audit_store.insert_event(&event).await {
        Ok(inserted_id) => (
            StatusCode::CREATED,
            axum::Json(json!({ "id": inserted_id })),
        ),
        Err(insert_error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": insert_error })),
        ),
    }
}

async fn handle_query_audit_events(
    State(http_api_state): State<HttpApiState>,
    Query(params): Query<AuditQueryParams>,
) -> impl IntoResponse {
    let Some(ref audit_store) = http_api_state.audit_store else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": "audit store not available" })),
        );
    };

    let events = audit_store.query_events(&params).await;
    (StatusCode::OK, axum::Json(json!({ "events": events })))
}

async fn handle_audit_by_session(
    State(http_api_state): State<HttpApiState>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let Some(ref audit_store) = http_api_state.audit_store else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": "audit store not available" })),
        );
    };

    let events = audit_store.query_by_session(&session_id).await;
    (StatusCode::OK, axum::Json(json!({ "events": events })))
}

async fn handle_audit_summary(State(http_api_state): State<HttpApiState>) -> impl IntoResponse {
    let Some(ref audit_store) = http_api_state.audit_store else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": "audit store not available" })),
        );
    };

    let summary = audit_store.summary().await;
    (StatusCode::OK, axum::Json(json!(summary)))
}

const SSE_KEEP_ALIVE_INTERVAL_SECONDS: u64 = 15;

fn build_event_stream(
    broadcaster: EventBroadcaster,
    allowed_event_types: Option<Vec<DaemonEventType>>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let broadcast_receiver = broadcaster.subscribe();
    BroadcastStream::new(broadcast_receiver).filter_map(move |broadcast_result| {
        match broadcast_result {
            Ok(daemon_event) => {
                let passes_filter = match &allowed_event_types {
                    Some(allowed_types) => allowed_types.contains(&daemon_event.event_type),
                    None => true,
                };

                if !passes_filter {
                    return None;
                }

                let event_topic = daemon_event.event_type.as_topic().to_string();
                match serde_json::to_string(&daemon_event) {
                    Ok(serialized_event) => Some(Ok(Event::default()
                        .event(event_topic)
                        .data(serialized_event))),
                    Err(_) => None,
                }
            }
            Err(_) => None,
        }
    })
}

async fn handle_event_stream_request(
    State(http_api_state): State<HttpApiState>,
    Query(query_params): Query<EventStreamQueryParameters>,
) -> impl IntoResponse {
    let broadcaster = match &http_api_state.event_broadcaster {
        Some(broadcaster) => broadcaster.clone(),
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(json!({ "error": "event streaming not available" })),
            ));
        }
    };

    let allowed_event_types: Option<Vec<DaemonEventType>> =
        query_params.events.as_ref().map(|events_csv| {
            events_csv
                .split(',')
                .filter_map(|event_name| DaemonEventType::from_string(event_name.trim()))
                .collect()
        });

    let event_stream = build_event_stream(broadcaster, allowed_event_types);

    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new().interval(Duration::from_secs(SSE_KEEP_ALIVE_INTERVAL_SECONDS)),
    ))
}

// ── Pairing & Users API ───────────────────────────────────────────────

#[derive(Deserialize)]
struct PairingQuery {
    channel: Option<String>,
}

#[derive(Deserialize)]
struct PairingActionBody {
    channel: String,
    code: String,
}

#[derive(Deserialize)]
struct AddUserBody {
    channel: String,
    #[serde(rename = "platformId")]
    platform_id: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

async fn handle_list_pairing_requests(
    State(state): State<HttpApiState>,
    Query(query): Query<PairingQuery>,
) -> impl IntoResponse {
    let channel = query.channel.as_deref().unwrap_or("telegram");
    let Some(reload_handle) = &state.reload_handle else {
        return Json(serde_json::json!({"error": "daemon not fully initialized"})).into_response();
    };
    match reload_handle
        .channel_user_store
        .get_pending_requests(channel)
        .await
    {
        Ok(requests) => {
            let entries: Vec<serde_json::Value> = requests
                .into_iter()
                .map(|r| {
                    serde_json::json!({
                        "code": r.pairing_code,
                        "platformId": r.platform_id,
                        "displayName": r.display_name,
                        "expiresAt": r.expires_at,
                    })
                })
                .collect();
            Json(serde_json::json!({"requests": entries})).into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": err})),
        )
            .into_response(),
    }
}

async fn handle_approve_pairing(
    State(state): State<HttpApiState>,
    Json(body): Json<PairingActionBody>,
) -> impl IntoResponse {
    let Some(reload_handle) = &state.reload_handle else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "daemon not fully initialized"})),
        )
            .into_response();
    };
    let code = body.code.to_uppercase();
    match reload_handle
        .channel_user_store
        .approve_pairing(&body.channel, &code)
        .await
    {
        Ok(user) => Json(serde_json::json!({
            "status": "approved",
            "platformId": user.platform_id,
            "displayName": user.display_name,
            "channel": user.channel_type,
        }))
        .into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": err})),
        )
            .into_response(),
    }
}

async fn handle_reject_pairing(
    State(state): State<HttpApiState>,
    Json(body): Json<PairingActionBody>,
) -> impl IntoResponse {
    let Some(reload_handle) = &state.reload_handle else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "daemon not fully initialized"})),
        )
            .into_response();
    };
    let code = body.code.to_uppercase();
    match reload_handle
        .channel_user_store
        .reject_pairing(&body.channel, &code)
        .await
    {
        Ok(request) => Json(serde_json::json!({
            "status": "rejected",
            "platformId": request.platform_id,
            "channel": request.channel_type,
        }))
        .into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": err})),
        )
            .into_response(),
    }
}

async fn handle_list_users(
    State(state): State<HttpApiState>,
    Query(query): Query<PairingQuery>,
) -> impl IntoResponse {
    let Some(reload_handle) = &state.reload_handle else {
        return Json(serde_json::json!({"error": "daemon not fully initialized"})).into_response();
    };
    match reload_handle
        .channel_user_store
        .list_authorized(query.channel.as_deref())
        .await
    {
        Ok(users) => {
            let entries: Vec<serde_json::Value> = users
                .into_iter()
                .map(|u| {
                    serde_json::json!({
                        "channelType": u.channel_type,
                        "platformId": u.platform_id,
                        "displayName": u.display_name,
                        "authorizedAt": u.authorized_at,
                        "authorizedBy": u.authorized_by,
                    })
                })
                .collect();
            Json(serde_json::json!({"users": entries})).into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": err})),
        )
            .into_response(),
    }
}

async fn handle_add_user(
    State(state): State<HttpApiState>,
    Json(body): Json<AddUserBody>,
) -> impl IntoResponse {
    let Some(reload_handle) = &state.reload_handle else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "daemon not fully initialized"})),
        )
            .into_response();
    };
    match reload_handle
        .channel_user_store
        .authorize_user(
            &body.channel,
            &body.platform_id,
            body.display_name.as_deref(),
            "api",
        )
        .await
    {
        Ok(user) => Json(serde_json::json!({
            "status": "authorized",
            "platformId": user.platform_id,
            "displayName": user.display_name,
            "channel": user.channel_type,
        }))
        .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": err})),
        )
            .into_response(),
    }
}

async fn handle_remove_user(
    State(state): State<HttpApiState>,
    Path((channel, platform_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let Some(reload_handle) = &state.reload_handle else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "daemon not fully initialized"})),
        )
            .into_response();
    };
    match reload_handle
        .channel_user_store
        .revoke_user(&channel, &platform_id)
        .await
    {
        Ok(true) => Json(serde_json::json!({
            "status": "revoked",
            "platformId": platform_id,
            "channel": channel,
        }))
        .into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("user '{}' not found on '{}'", platform_id, channel)})),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": err})),
        )
            .into_response(),
    }
}

// ── Channel Send API ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct ChannelSendBody {
    /// Channel type: "telegram", "discord"
    channel: String,
    /// Target chat/channel ID
    #[serde(rename = "chatId")]
    chat_id: String,
    /// Message text (markdown)
    message: String,
}

async fn handle_channel_send(
    State(state): State<HttpApiState>,
    Json(body): Json<ChannelSendBody>,
) -> impl IntoResponse {
    let Some(reload_handle) = &state.reload_handle else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "daemon not fully initialized"})),
        )
            .into_response();
    };

    let router_guard = reload_handle.channel_router_handle.read().await;
    let Some(router_handle) = router_guard.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "channel router not available"})),
        )
            .into_response();
    };

    let Some(adapter) = router_handle.get_adapter(&body.channel) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("no adapter for channel: {}", body.channel)})),
        )
            .into_response();
    };

    // Use Text so each adapter converts to its native format
    match adapter
        .send_message(
            &body.chat_id,
            crate::channels::types::MessageContent::Text(body.message),
        )
        .await
    {
        Ok(()) => Json(serde_json::json!({"status": "sent"})).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("{err}")})),
        )
            .into_response(),
    }
}

async fn handle_channel_sessions(State(state): State<HttpApiState>) -> impl IntoResponse {
    let Some(reload_handle) = &state.reload_handle else {
        return Json(serde_json::json!({"error": "daemon not fully initialized"})).into_response();
    };

    let pool = reload_handle.database_pool.clone();
    let session_store = crate::db::channel_sessions::ChannelSessionStore::new(pool);
    if let Err(err) = session_store.initialize().await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("failed to init session store: {err}")})),
        )
            .into_response();
    }

    match session_store.list_sessions(None).await {
        Ok(sessions) => {
            let entries: Vec<serde_json::Value> = sessions
                .into_iter()
                .map(|s| {
                    serde_json::json!({
                        "channelType": s.channel_type,
                        "chatId": s.chat_id,
                        "lastMessageAt": s.last_message_at,
                    })
                })
                .collect();
            Json(serde_json::json!({"sessions": entries})).into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": err})),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    use uuid::Uuid;

    async fn create_test_task_store() -> Arc<TaskStore> {
        let temporary_directory = std::env::temp_dir();
        let database_path =
            temporary_directory.join(format!("kraken_test_http_api_{}.sqlite", Uuid::new_v4()));

        let database_pool = open_database(&database_path).expect("should open test database");

        Arc::new(TaskStore::new(database_pool))
    }

    fn build_test_router(task_store: Arc<TaskStore>) -> Router {
        let http_api_state = HttpApiState {
            task_store,
            shutdown_sender: None,
            active_worker_count: None,
            max_concurrent_workers: 0,
            daemon_start_time: None,
            daemon_port: 50051,
            config_path: None,
            heartbeat_tracker: None,
            event_broadcaster: None,
            audit_store: None,
            loop_detector: None,
            reload_handle: None,
            widget_token: None,
        };

        Router::new()
            .route("/api/schedule", post(handle_schedule_task_request))
            .route("/api/health", get(handle_health_check_request))
            .route("/api/widget", get(handle_widget_request))
            .route("/api/status", get(handle_status_request))
            .route("/api/shutdown", post(handle_shutdown_request))
            .route("/api/tasks", get(handle_list_tasks_request))
            .route(
                "/api/tasks/{task_id}",
                get(handle_get_task_request).delete(handle_delete_task_request),
            )
            .route(
                "/api/tasks/{task_id}/cancel",
                post(handle_cancel_task_request),
            )
            .route(
                "/api/tasks/{task_id}/retry",
                post(handle_retry_task_request),
            )
            .route(
                "/api/tasks/{task_id}/logs",
                get(handle_get_task_logs_request),
            )
            .route("/api/stats", get(handle_stats_request))
            .route("/api/clean", post(handle_clean_request))
            .route("/api/config", get(handle_get_config_request))
            .route(
                "/api/tasks/{task_id}/usage",
                post(handle_report_usage_request),
            )
            .with_state(http_api_state)
    }

    #[tokio::test]
    async fn test_health_check_returns_ok() {
        let task_store = create_test_task_store().await;
        let router = build_test_router(task_store);

        let request = Request::builder()
            .method("GET")
            .uri("/api/health")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let response_body = response.into_body().collect().await.unwrap().to_bytes();
        let response_json: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response_json["status"], "ok");
    }

    #[tokio::test]
    async fn test_status_returns_running_true() {
        let task_store = create_test_task_store().await;
        let router = build_test_router(task_store);

        let request = Request::builder()
            .method("GET")
            .uri("/api/status")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let response_body = response.into_body().collect().await.unwrap().to_bytes();
        let response_json: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response_json["running"], true);
        assert!(response_json["pid"].is_number());
    }

    #[tokio::test]
    async fn test_shutdown_without_sender_returns_service_unavailable() {
        let task_store = create_test_task_store().await;
        let router = build_test_router(task_store);

        let request = Request::builder()
            .method("POST")
            .uri("/api/shutdown")
            .body(Body::empty())
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_schedule_task_creates_task_and_returns_id() {
        let task_store = create_test_task_store().await;
        let router = build_test_router(task_store);

        let request_body = serde_json::to_vec(&json!({
            "prompt": "refactor the auth module"
        }))
        .unwrap();

        let request = Request::builder()
            .method("POST")
            .uri("/api/schedule")
            .header("content-type", "application/json")
            .body(Body::from(request_body))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        let response_body = response.into_body().collect().await.unwrap().to_bytes();
        let response_json: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response_json["status"], "scheduled");
        assert!(response_json["task_id"].is_string());
    }

    #[tokio::test]
    async fn test_schedule_task_with_cron_expression() {
        let task_store = create_test_task_store().await;
        let router = build_test_router(task_store);

        let request_body = serde_json::to_vec(&json!({
            "prompt": "run daily cleanup",
            "cron_expression": "0 0 * * *"
        }))
        .unwrap();

        let request = Request::builder()
            .method("POST")
            .uri("/api/schedule")
            .header("content-type", "application/json")
            .body(Body::from(request_body))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        let response_body = response.into_body().collect().await.unwrap().to_bytes();
        let response_json: serde_json::Value = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response_json["status"], "scheduled");
    }

    #[tokio::test]
    async fn test_schedule_task_with_run_at() {
        let task_store = create_test_task_store().await;
        let router = build_test_router(task_store);

        let request_body = serde_json::to_vec(&json!({
            "prompt": "deploy to staging",
            "run_at": "2026-04-01T12:00:00Z"
        }))
        .unwrap();

        let request = Request::builder()
            .method("POST")
            .uri("/api/schedule")
            .header("content-type", "application/json")
            .body(Body::from(request_body))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn test_schedule_task_with_invalid_json_returns_error() {
        let task_store = create_test_task_store().await;
        let router = build_test_router(task_store);

        let request = Request::builder()
            .method("POST")
            .uri("/api/schedule")
            .header("content-type", "application/json")
            .body(Body::from("not valid json"))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        // axum returns 400 Bad Request for syntactically-invalid JSON bodies
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
