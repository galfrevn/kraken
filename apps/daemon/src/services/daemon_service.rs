use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

use chrono::NaiveDateTime;
use prost_types::Timestamp;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::Stream;
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use crate::cron::CronEngine;
use crate::daemon::reload::{ReloadableNotificationDispatcher, reload_configuration_from_disk};
use crate::db::tasks::{DaemonTask, TaskStore};
use crate::orchestrator::Orchestrator;
use crate::proto::agent::v1::{
    daemon_service_server::DaemonService,
    DaemonServiceCancelTaskRequest, DaemonServiceCancelTaskResponse,
    DaemonServiceListTasksRequest, DaemonServiceListTasksResponse,
    DaemonServiceSubmitTaskRequest, DaemonServiceSubmitTaskResponse,
    DaemonTask as DaemonTaskProto,
    GetStatusRequest, GetStatusResponse,
    GetTaskDetailRequest, GetTaskDetailResponse,
    ReloadConfigRequest, ReloadConfigResponse,
    StreamTaskLogsRequest, StreamTaskLogsResponse,
    TaskLogEntry,
    WatchTasksRequest, WatchTasksResponse,
};
use crate::triggers::engine::TriggerEngine;
use crate::watcher::FileWatcherEngine;

use super::worker_service::WorkerActivityEvent;

/// Implements the DaemonService gRPC trait generated from daemon.proto.
///
/// This is the management interface that TUI and CLI connect to for:
/// - Checking daemon health and status (`get_status`)
/// - Submitting new tasks (`submit_task`)
/// - Listing and inspecting tasks (`list_tasks`, `get_task_detail`)
/// - Cancelling running tasks (`cancel_task`)
/// - Watching live task activity updates (`watch_tasks`)
pub struct DaemonServiceImplementation {
    task_store: Arc<TaskStore>,
    orchestrator: Arc<Orchestrator>,
    uptime_start_time: Instant,
    max_concurrent_workers: u32,
    activity_event_sender: broadcast::Sender<WorkerActivityEvent>,
    llm_providers_are_configured: bool,
    cron_engine: Arc<CronEngine>,
    file_watcher_engine: Arc<FileWatcherEngine>,
    trigger_engine: Arc<TriggerEngine>,
    reloadable_notification_dispatcher: Arc<ReloadableNotificationDispatcher>,
    configuration_file_path: Option<PathBuf>,
}

impl DaemonServiceImplementation {
    pub fn new(
        task_store: Arc<TaskStore>,
        orchestrator: Arc<Orchestrator>,
        uptime_start_time: Instant,
        max_concurrent_workers: u32,
        activity_event_sender: broadcast::Sender<WorkerActivityEvent>,
        llm_providers_are_configured: bool,
        cron_engine: Arc<CronEngine>,
        file_watcher_engine: Arc<FileWatcherEngine>,
        trigger_engine: Arc<TriggerEngine>,
        reloadable_notification_dispatcher: Arc<ReloadableNotificationDispatcher>,
        configuration_file_path: Option<PathBuf>,
    ) -> Self {
        Self {
            task_store,
            orchestrator,
            uptime_start_time,
            max_concurrent_workers,
            activity_event_sender,
            llm_providers_are_configured,
            cron_engine,
            file_watcher_engine,
            trigger_engine,
            reloadable_notification_dispatcher,
            configuration_file_path,
        }
    }
}

/// Converts a database DaemonTask to the proto DaemonTask message.
fn convert_daemon_task_to_proto(task: DaemonTask) -> DaemonTaskProto {
    DaemonTaskProto {
        id: task.id,
        name: task.name,
        status: task.status,
        priority: task.priority,
        trigger_type: task.trigger_type.unwrap_or_default(),
        worker_pid: task.worker_pid.unwrap_or(0) as i32,
        output: task.output.unwrap_or_default(),
        error_message: task.error_message.unwrap_or_default(),
        prompt_tokens: task.prompt_tokens,
        completion_tokens: task.completion_tokens,
        estimated_cost_usd: task.estimated_cost_usd,
        created_at: parse_rfc3339_to_timestamp(&task.created_at),
        started_at: task
            .started_at
            .as_deref()
            .and_then(parse_rfc3339_to_timestamp),
        completed_at: task
            .completed_at
            .as_deref()
            .and_then(parse_rfc3339_to_timestamp),
    }
}

/// Parses an RFC3339-style datetime string (as stored by SQLite's `datetime('now')`)
/// into a protobuf Timestamp. SQLite stores datetimes as `YYYY-MM-DD HH:MM:SS`,
/// which is not strictly RFC3339 but can be parsed with NaiveDateTime.
///
/// Returns None if the string cannot be parsed.
fn parse_rfc3339_to_timestamp(datetime_string: &str) -> Option<Timestamp> {
    // SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS" (no timezone, always UTC)
    let naive_datetime =
        NaiveDateTime::parse_from_str(datetime_string, "%Y-%m-%d %H:%M:%S").ok()?;

    let unix_seconds = naive_datetime
        .and_utc()
        .timestamp();

    Some(Timestamp {
        seconds: unix_seconds,
        nanos: 0,
    })
}

#[tonic::async_trait]
impl DaemonService for DaemonServiceImplementation {
    /// Returns the current health and status of the daemon.
    ///
    /// Includes uptime, worker counts, pending/completed task counts,
    /// and LLM gateway status. The daemon itself handles LLM requests
    /// directly (no separate Go gateway process), so `gateway_connected`
    /// is always `true`. The `llm_providers_are_configured` field tracks
    /// whether workers will actually be able to make LLM completion calls.
    async fn get_status(
        &self,
        _request: Request<GetStatusRequest>,
    ) -> Result<Response<GetStatusResponse>, Status> {
        let uptime_seconds = self.uptime_start_time.elapsed().as_secs() as i64;
        let active_workers = self.orchestrator.active_worker_count() as i32;
        let pending_tasks = self.task_store.count_by_status("pending").await;
        let completed_tasks_today = self.task_store.count_completed_today().await;

        // The daemon IS the LLM gateway now — gateway_connected is always true.
        // Whether LLM calls will succeed depends on llm_providers_are_configured.
        let gateway_connected = true;

        if !self.llm_providers_are_configured {
            warn!(
                "no LLM providers configured -- workers will fail on completion requests"
            );
        }

        info!(
            uptime_seconds = uptime_seconds,
            active_workers = active_workers,
            pending_tasks = pending_tasks,
            completed_tasks_today = completed_tasks_today,
            gateway_connected = gateway_connected,
            llm_providers_configured = self.llm_providers_are_configured,
            "status requested"
        );

        Ok(Response::new(GetStatusResponse {
            healthy: true,
            uptime_seconds,
            active_workers,
            max_workers: self.max_concurrent_workers as i32,
            pending_tasks,
            completed_tasks_today,
            gateway_connected,
        }))
    }

    /// Creates a new task via the task store.
    ///
    /// If the submitted priority is 0, it defaults to 5 (medium priority).
    /// Returns the generated task ID.
    async fn submit_task(
        &self,
        request: Request<DaemonServiceSubmitTaskRequest>,
    ) -> Result<Response<DaemonServiceSubmitTaskResponse>, Status> {
        let submit_request = request.into_inner();
        let task_name = &submit_request.name;
        let task_description = &submit_request.description;
        let task_priority = if submit_request.priority == 0 {
            5
        } else {
            submit_request.priority
        };

        info!(
            name = %task_name,
            description = %task_description,
            priority = task_priority,
            "task submitted"
        );

        let created_task = self
            .task_store
            .create_task(task_name, task_description, task_priority)
            .await
            .map_err(|error| {
                Status::internal(format!("failed to create task: {error}"))
            })?;

        Ok(Response::new(DaemonServiceSubmitTaskResponse {
            task_id: created_task.id,
        }))
    }

    /// Lists tasks with an optional status filter and limit.
    ///
    /// If no limit is provided (or 0), defaults to 50.
    /// Tasks are ordered by priority (ascending) then by creation time.
    async fn list_tasks(
        &self,
        request: Request<DaemonServiceListTasksRequest>,
    ) -> Result<Response<DaemonServiceListTasksResponse>, Status> {
        let list_request = request.into_inner();

        let status_filter = if list_request.status_filter.is_empty() {
            None
        } else {
            Some(list_request.status_filter.as_str())
        };

        let limit = if list_request.limit == 0 {
            50
        } else {
            list_request.limit
        };

        let tasks = self
            .task_store
            .list_tasks(status_filter, limit)
            .await;

        let proto_tasks: Vec<DaemonTaskProto> = tasks
            .into_iter()
            .map(convert_daemon_task_to_proto)
            .collect();

        Ok(Response::new(DaemonServiceListTasksResponse {
            tasks: proto_tasks,
        }))
    }

    /// Returns detailed information about a single task, including its logs.
    ///
    /// Returns NotFound if no task exists with the given ID.
    async fn get_task_detail(
        &self,
        request: Request<GetTaskDetailRequest>,
    ) -> Result<Response<GetTaskDetailResponse>, Status> {
        let detail_request = request.into_inner();
        let task_id = &detail_request.task_id;

        let task = self
            .task_store
            .get_task(task_id)
            .await
            .ok_or_else(|| Status::not_found(format!("task not found: {task_id}")))?;

        let task_logs = self.task_store.get_task_logs(task_id).await;

        let proto_logs: Vec<TaskLogEntry> = task_logs
            .into_iter()
            .map(|(level, message, created_at)| TaskLogEntry {
                level,
                message,
                timestamp: parse_rfc3339_to_timestamp(&created_at),
            })
            .collect();

        // Parse artifacts from the JSON stored in the task, if present
        let proto_artifacts = task
            .artifacts
            .as_deref()
            .and_then(|artifacts_json| {
                serde_json::from_str::<Vec<serde_json::Value>>(artifacts_json).ok()
            })
            .map(|artifact_values| {
                artifact_values
                    .into_iter()
                    .map(|value| {
                        crate::proto::agent::v1::Artifact {
                            r#type: value
                                .get("type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            url: value
                                .get("url")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            name: value
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let proto_task = convert_daemon_task_to_proto(task);

        Ok(Response::new(GetTaskDetailResponse {
            task: Some(proto_task),
            logs: proto_logs,
            artifacts: proto_artifacts,
        }))
    }

    /// Cancels a task by updating its status to "cancelled".
    ///
    /// The orchestrator's tick loop will detect the cancelled status and
    /// kill the associated worker process if one is running.
    async fn cancel_task(
        &self,
        request: Request<DaemonServiceCancelTaskRequest>,
    ) -> Result<Response<DaemonServiceCancelTaskResponse>, Status> {
        let cancel_request = request.into_inner();
        let task_id = &cancel_request.task_id;

        info!(task_id = %task_id, "cancel requested");

        // Verify the task exists before attempting cancellation
        let task = self
            .task_store
            .get_task(task_id)
            .await
            .ok_or_else(|| Status::not_found(format!("task not found: {task_id}")))?;

        // Only cancel tasks that are in a cancellable state
        if task.status == "completed" || task.status == "failed" || task.status == "cancelled" {
            warn!(
                task_id = %task_id,
                status = %task.status,
                "cannot cancel task in terminal state"
            );
            return Ok(Response::new(DaemonServiceCancelTaskResponse {
                success: false,
            }));
        }

        self.task_store
            .update_status(task_id, "cancelled")
            .await
            .map_err(|error| {
                Status::internal(format!("failed to cancel task: {error}"))
            })?;

        info!(task_id = %task_id, "task cancelled");

        Ok(Response::new(DaemonServiceCancelTaskResponse {
            success: true,
        }))
    }

    type WatchTasksStream =
        Pin<Box<dyn Stream<Item = Result<WatchTasksResponse, Status>> + Send>>;

    /// Server-streaming RPC that pushes live task activity updates to subscribers.
    ///
    /// Subscribes to the broadcast channel of WorkerActivityEvents and converts
    /// each event into a WatchTasksResponse. The stream ends when the client
    /// disconnects or the broadcast channel is closed.
    async fn watch_tasks(
        &self,
        _request: Request<WatchTasksRequest>,
    ) -> Result<Response<Self::WatchTasksStream>, Status> {
        info!("client subscribed to task watch stream");

        let broadcast_receiver = self.activity_event_sender.subscribe();
        let broadcast_stream = BroadcastStream::new(broadcast_receiver);

        let task_store = Arc::clone(&self.task_store);

        let response_stream = broadcast_stream
            .then(move |event_result| {
                let task_store = Arc::clone(&task_store);
                async move {
                    match event_result {
                        Ok(activity_event) => {
                            // Fetch the current task state to include in the response
                            let proto_task = task_store
                                .get_task(&activity_event.task_id)
                                .await
                                .map(convert_daemon_task_to_proto);

                            Some(Ok(WatchTasksResponse {
                                event_type: "activity".to_string(),
                                task: proto_task,
                                activity: activity_event.activity,
                            }))
                        }
                        Err(_broadcast_error) => {
                            // Lagged errors are normal under high throughput; skip them
                            None
                        }
                    }
                }
            })
            .filter_map(|item| item);

        Ok(Response::new(Box::pin(response_stream)))
    }

    type StreamTaskLogsStream =
        Pin<Box<dyn Stream<Item = Result<StreamTaskLogsResponse, Status>> + Send>>;

    async fn stream_task_logs(
        &self,
        _request: Request<StreamTaskLogsRequest>,
    ) -> Result<Response<Self::StreamTaskLogsStream>, Status> {
        Err(Status::unimplemented(
            "log streaming not yet implemented",
        ))
    }

    async fn reload_config(
        &self,
        _request: Request<ReloadConfigRequest>,
    ) -> Result<Response<ReloadConfigResponse>, Status> {
        info!("reload_config RPC called");

        match reload_configuration_from_disk(
            self.configuration_file_path.as_ref(),
            &self.reloadable_notification_dispatcher,
            &self.cron_engine,
            &self.file_watcher_engine,
            &self.trigger_engine,
        )
        .await
        {
            Ok(reload_result) => Ok(Response::new(ReloadConfigResponse {
                success: true,
                message: "configuration reloaded successfully".to_string(),
                cron_triggers_loaded: reload_result.cron_trigger_count as i32,
                webhook_triggers_loaded: reload_result.webhook_trigger_count as i32,
                watcher_triggers_loaded: reload_result.watcher_trigger_count as i32,
                notification_channels_loaded: reload_result.notification_channel_count as i32,
            })),
            Err(reload_error_message) => Ok(Response::new(ReloadConfigResponse {
                success: false,
                message: reload_error_message,
                cron_triggers_loaded: 0,
                webhook_triggers_loaded: 0,
                watcher_triggers_loaded: 0,
                notification_channels_loaded: 0,
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rfc3339_to_timestamp_valid() {
        let timestamp = parse_rfc3339_to_timestamp("2025-01-15 10:30:00");
        assert!(timestamp.is_some());

        let proto_timestamp = timestamp.unwrap();
        assert!(proto_timestamp.seconds > 0);
        assert_eq!(proto_timestamp.nanos, 0);
    }

    #[test]
    fn test_parse_rfc3339_to_timestamp_invalid() {
        let timestamp = parse_rfc3339_to_timestamp("not-a-date");
        assert!(timestamp.is_none());
    }

    #[test]
    fn test_parse_rfc3339_to_timestamp_empty() {
        let timestamp = parse_rfc3339_to_timestamp("");
        assert!(timestamp.is_none());
    }

    #[test]
    fn test_parse_rfc3339_to_timestamp_known_value() {
        // 2024-01-01 00:00:00 UTC = 1704067200 Unix seconds
        let timestamp = parse_rfc3339_to_timestamp("2024-01-01 00:00:00");
        assert!(timestamp.is_some());

        let proto_timestamp = timestamp.unwrap();
        assert_eq!(proto_timestamp.seconds, 1704067200);
    }

    #[test]
    fn test_convert_daemon_task_to_proto_minimal() {
        let task = DaemonTask {
            id: "task-001".to_string(),
            name: "test task".to_string(),
            description: "a description".to_string(),
            status: "pending".to_string(),
            priority: 5,
            trigger_id: None,
            trigger_type: None,
            trigger_payload: None,
            worker_pid: None,
            worker_dir: None,
            started_at: None,
            completed_at: None,
            updated_at: "2025-01-15 10:30:00".to_string(),
            timeout_ms: 300000,
            exit_code: None,
            output: None,
            error_message: None,
            artifacts: None,
            prompt_tokens: 0,
            completion_tokens: 0,
            estimated_cost_usd: 0.0,
            attempt: 1,
            max_retries: 3,
            created_at: "2025-01-15 10:30:00".to_string(),
        };

        let proto_task = convert_daemon_task_to_proto(task);
        assert_eq!(proto_task.id, "task-001");
        assert_eq!(proto_task.name, "test task");
        assert_eq!(proto_task.status, "pending");
        assert_eq!(proto_task.priority, 5);
        assert_eq!(proto_task.trigger_type, "");
        assert_eq!(proto_task.worker_pid, 0);
        assert_eq!(proto_task.output, "");
        assert_eq!(proto_task.error_message, "");
        assert_eq!(proto_task.prompt_tokens, 0);
        assert_eq!(proto_task.completion_tokens, 0);
        assert!((proto_task.estimated_cost_usd - 0.0).abs() < f64::EPSILON);
        assert!(proto_task.created_at.is_some());
        assert!(proto_task.started_at.is_none());
        assert!(proto_task.completed_at.is_none());
    }

    #[test]
    fn test_convert_daemon_task_to_proto_with_all_fields() {
        let task = DaemonTask {
            id: "task-002".to_string(),
            name: "completed task".to_string(),
            description: "finished work".to_string(),
            status: "completed".to_string(),
            priority: 1,
            trigger_id: Some("trigger-001".to_string()),
            trigger_type: Some("cron".to_string()),
            trigger_payload: Some("0 * * * *".to_string()),
            worker_pid: Some(12345),
            worker_dir: Some("/tmp/work".to_string()),
            started_at: Some("2025-01-15 10:30:00".to_string()),
            completed_at: Some("2025-01-15 10:35:00".to_string()),
            updated_at: "2025-01-15 10:35:00".to_string(),
            timeout_ms: 300000,
            exit_code: Some(0),
            output: Some("all good".to_string()),
            error_message: Some("".to_string()),
            artifacts: None,
            prompt_tokens: 500,
            completion_tokens: 200,
            estimated_cost_usd: 0.015,
            attempt: 1,
            max_retries: 3,
            created_at: "2025-01-15 10:29:00".to_string(),
        };

        let proto_task = convert_daemon_task_to_proto(task);
        assert_eq!(proto_task.id, "task-002");
        assert_eq!(proto_task.name, "completed task");
        assert_eq!(proto_task.status, "completed");
        assert_eq!(proto_task.priority, 1);
        assert_eq!(proto_task.trigger_type, "cron");
        assert_eq!(proto_task.worker_pid, 12345);
        assert_eq!(proto_task.output, "all good");
        assert_eq!(proto_task.prompt_tokens, 500);
        assert_eq!(proto_task.completion_tokens, 200);
        assert!((proto_task.estimated_cost_usd - 0.015).abs() < 1e-9);
        assert!(proto_task.created_at.is_some());
        assert!(proto_task.started_at.is_some());
        assert!(proto_task.completed_at.is_some());
    }
}
