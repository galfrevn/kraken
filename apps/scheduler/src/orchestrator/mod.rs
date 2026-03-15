pub mod heartbeat;
pub mod worker;
pub mod worktree;

use std::path::PathBuf;
use std::sync::Arc;

use std::collections::HashMap;

use dashmap::DashMap;
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::db::tasks::TaskStore;
use crate::notifications::dispatcher::NotificationDispatcher;
use crate::notifications::types::{NotificationEvent, NotificationEventType};
use heartbeat::HeartbeatTracker;
use worker::WorkerProcess;
use worktree::WorktreeManager;

/// Exit code assigned to tasks killed due to heartbeat timeout.
/// This distinguishes daemon-initiated kills from normal worker failures.
const HEARTBEAT_TIMEOUT_EXIT_CODE: i32 = 10;

/// Number of tick cycles (each ~1 second) between stale worktree cleanup runs.
/// 6 hours = 6 * 60 * 60 = 21600 ticks.
const STALE_WORKTREE_CLEANUP_INTERVAL_TICKS: u64 = 21600;

/// Maximum age in days before a worktree is considered stale and eligible for cleanup.
const STALE_WORKTREE_MAXIMUM_AGE_DAYS: u32 = 7;

/// Number of tick cycles (each ~1 second) between daily digest notification dispatches.
/// 24 hours = 24 * 60 * 60 = 86400 ticks.
const DAILY_DIGEST_INTERVAL_TICKS: u64 = 86400;

pub struct Orchestrator {
    task_store: Arc<TaskStore>,
    heartbeat_tracker: Arc<HeartbeatTracker>,
    active_workers: Arc<DashMap<String, WorkerProcess>>,
    max_concurrent_workers: u32,
    max_retries: u32,
    backoff_seconds: u64,
    daemon_url: String,
    worker_script_path: String,
    repository_directory: String,
    worktree_manager: Arc<WorktreeManager>,
    shutdown_receiver: watch::Receiver<bool>,
    ticks_since_last_stale_worktree_cleanup: u64,
    ticks_since_last_daily_digest: u64,
    notification_dispatcher: Arc<NotificationDispatcher>,
}

impl Orchestrator {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        task_store: Arc<TaskStore>,
        max_concurrent_workers: u32,
        heartbeat_timeout_seconds: u64,
        max_retries: u32,
        backoff_seconds: u64,
        daemon_url: String,
        worker_script_path: String,
        repository_directory: String,
        branch_prefix: String,
        shutdown_receiver: watch::Receiver<bool>,
        notification_dispatcher: Arc<NotificationDispatcher>,
    ) -> Self {
        let heartbeat_tracker = Arc::new(HeartbeatTracker::new(heartbeat_timeout_seconds));
        let worktree_manager = Arc::new(WorktreeManager::new(
            &PathBuf::from(&repository_directory),
            &branch_prefix,
        ));

        info!(
            max_concurrent_workers = max_concurrent_workers,
            heartbeat_timeout_seconds = heartbeat_timeout_seconds,
            max_retries = max_retries,
            backoff_seconds = backoff_seconds,
            repository_directory = %repository_directory,
            branch_prefix = %branch_prefix,
            "orchestrator created"
        );

        Self {
            task_store,
            heartbeat_tracker,
            active_workers: Arc::new(DashMap::new()),
            max_concurrent_workers,
            max_retries,
            backoff_seconds,
            daemon_url,
            worker_script_path,
            repository_directory,
            worktree_manager,
            shutdown_receiver,
            ticks_since_last_stale_worktree_cleanup: 0,
            ticks_since_last_daily_digest: 0,
            notification_dispatcher,
        }
    }

    pub fn get_heartbeat_tracker(&self) -> Arc<HeartbeatTracker> {
        Arc::clone(&self.heartbeat_tracker)
    }

    fn fire_notification(&self, notification_event: NotificationEvent) {
        let dispatcher_for_background_send = Arc::clone(&self.notification_dispatcher);
        tokio::spawn(async move {
            dispatcher_for_background_send
                .dispatch(notification_event)
                .await;
        });
    }

    async fn fire_notification_for_completed_worker(&self, task_id: &str, exit_code: i32) {
        let task_from_store = match self.task_store.get_task(task_id).await {
            Some(task) => task,
            None => return,
        };

        if exit_code == 0 {
            let mut completed_task_details = HashMap::new();

            if let Some(started_at_timestamp) = &task_from_store.started_at {
                if let Some(completed_at_timestamp) = &task_from_store.completed_at {
                    completed_task_details.insert(
                        "duration".to_string(),
                        format!("{} to {}", started_at_timestamp, completed_at_timestamp),
                    );
                }
            }

            if task_from_store.estimated_cost_usd > 0.0 {
                completed_task_details.insert(
                    "cost".to_string(),
                    format!("${:.4}", task_from_store.estimated_cost_usd),
                );
            }

            if let Some(artifacts_json) = &task_from_store.artifacts {
                if let Ok(parsed_artifacts) =
                    serde_json::from_str::<serde_json::Value>(artifacts_json)
                {
                    if let Some(pull_request_url) = parsed_artifacts
                        .get("pr_url")
                        .and_then(|value| value.as_str())
                    {
                        completed_task_details
                            .insert("pr_url".to_string(), pull_request_url.to_string());
                    }
                }
            }

            self.fire_notification(NotificationEvent {
                event_type: NotificationEventType::TaskCompleted,
                task_name: task_from_store.name.clone(),
                task_id: task_id.to_string(),
                summary: format!("Task '{}' completed successfully", task_from_store.name),
                details: completed_task_details,
                timestamp: chrono::Utc::now(),
            });
        } else {
            let mut failed_task_details = HashMap::new();

            if let Some(error_message) = &task_from_store.error_message {
                failed_task_details.insert("error".to_string(), error_message.clone());
            }

            self.fire_notification(NotificationEvent {
                event_type: NotificationEventType::TaskFailed,
                task_name: task_from_store.name.clone(),
                task_id: task_id.to_string(),
                summary: format!("Task '{}' failed with exit code {}", task_from_store.name, exit_code),
                details: failed_task_details,
                timestamp: chrono::Utc::now(),
            });
        }
    }

    pub fn active_worker_count(&self) -> usize {
        self.active_workers.len()
    }

    pub async fn run(&mut self) {
        info!("orchestrator loop started");

        loop {
            tokio::select! {
                result = self.shutdown_receiver.changed() => {
                    if result.is_ok() && *self.shutdown_receiver.borrow() {
                        info!("orchestrator received shutdown signal");
                        break;
                    }
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
                    self.tick().await;
                }
            }
        }

        self.shutdown_all_workers().await;
        info!("orchestrator loop stopped");
    }

    async fn tick(&mut self) {
        self.check_active_workers().await;

        let current_worker_count = self.active_workers.len() as u32;
        if current_worker_count < self.max_concurrent_workers
            && let Some(pending_task) = self.task_store.get_next_pending_task().await
        {
            self.spawn_worker_for_task(&pending_task.id, &pending_task.name)
                .await;
        }

        self.ticks_since_last_stale_worktree_cleanup += 1;
        if self.ticks_since_last_stale_worktree_cleanup >= STALE_WORKTREE_CLEANUP_INTERVAL_TICKS {
            self.ticks_since_last_stale_worktree_cleanup = 0;
            let worktree_manager_for_cleanup = Arc::clone(&self.worktree_manager);
            tokio::task::spawn_blocking(move || {
                let removed_count = worktree_manager_for_cleanup
                    .cleanup_stale_worktrees(STALE_WORKTREE_MAXIMUM_AGE_DAYS);
                if removed_count > 0 {
                    info!(
                        removed_count = removed_count,
                        "periodic stale worktree cleanup completed"
                    );
                }
            });
        }

        self.ticks_since_last_daily_digest += 1;
        if self.ticks_since_last_daily_digest >= DAILY_DIGEST_INTERVAL_TICKS {
            self.ticks_since_last_daily_digest = 0;
            self.fire_daily_digest_notification().await;
        }
    }

    async fn fire_daily_digest_notification(&self) {
        let daily_statistics = self.task_store.get_daily_statistics().await;

        let total_token_count =
            daily_statistics.total_prompt_tokens + daily_statistics.total_completion_tokens;

        let mut daily_digest_details = HashMap::new();
        daily_digest_details.insert(
            "completed".to_string(),
            daily_statistics.completed_task_count.to_string(),
        );
        daily_digest_details.insert(
            "failed".to_string(),
            daily_statistics.failed_task_count.to_string(),
        );
        daily_digest_details.insert(
            "total_cost_usd".to_string(),
            format!("${:.4}", daily_statistics.total_cost_usd),
        );
        daily_digest_details.insert(
            "total_tokens".to_string(),
            total_token_count.to_string(),
        );

        let digest_summary = format!(
            "Daily digest: {} completed, {} failed, {} tokens, ${:.4} cost",
            daily_statistics.completed_task_count,
            daily_statistics.failed_task_count,
            total_token_count,
            daily_statistics.total_cost_usd,
        );

        info!(
            completed = daily_statistics.completed_task_count,
            failed = daily_statistics.failed_task_count,
            total_tokens = total_token_count,
            total_cost_usd = daily_statistics.total_cost_usd,
            "firing daily digest notification"
        );

        self.fire_notification(NotificationEvent {
            event_type: NotificationEventType::DailyDigest,
            task_name: "daily-digest".to_string(),
            task_id: "daily-digest".to_string(),
            summary: digest_summary,
            details: daily_digest_details,
            timestamp: chrono::Utc::now(),
        });
    }

    fn is_retryable_exit_code(exit_code: i32) -> bool {
        matches!(exit_code, 1 | HEARTBEAT_TIMEOUT_EXIT_CODE)
    }

    async fn schedule_retry_for_failed_task(
        &self,
        task_id: &str,
        exit_code: i32,
        worker_working_directory: &str,
    ) {
        let task = match self.task_store.get_task(task_id).await {
            Some(task) => task,
            None => return,
        };

        let current_attempt = task.attempt;
        let max_allowed_attempts = self.max_retries + 1;

        if !Self::is_retryable_exit_code(exit_code) || current_attempt >= max_allowed_attempts as i32
        {
            return;
        }

        let error_description = task
            .error_message
            .as_deref()
            .unwrap_or("unknown error");
        let retry_context_message = format!(
            "Previous attempt {} failed: {}",
            current_attempt, error_description
        );

        if let Err(status_error) = self
            .task_store
            .update_status(task_id, "retrying")
            .await
        {
            error!(
                task_id = %task_id,
                error = %status_error,
                "failed to update task status to retrying"
            );
            return;
        }

        if let Err(increment_error) = self.task_store.increment_attempt(task_id).await {
            error!(
                task_id = %task_id,
                error = %increment_error,
                "failed to increment attempt counter"
            );
            return;
        }

        if let Err(context_error) = self
            .task_store
            .set_retry_context(task_id, &retry_context_message)
            .await
        {
            error!(
                task_id = %task_id,
                error = %context_error,
                "failed to set retry context"
            );
            return;
        }

        if worker_working_directory != self.repository_directory {
            let worktree_path = PathBuf::from(worker_working_directory);
            if let Err(reset_error) = self.worktree_manager.reset_worktree(&worktree_path) {
                warn!(
                    task_id = %task_id,
                    error = %reset_error,
                    "failed to reset worktree before retry"
                );
            }
        }

        info!(
            task_id = %task_id,
            attempt = current_attempt + 1,
            backoff_seconds = self.backoff_seconds,
            "scheduling retry after backoff"
        );

        let task_store_for_delayed_requeue = Arc::clone(&self.task_store);
        let task_id_for_delayed_requeue = task_id.to_string();
        let backoff_duration = tokio::time::Duration::from_secs(self.backoff_seconds);

        tokio::spawn(async move {
            tokio::time::sleep(backoff_duration).await;

            if let Err(status_error) = task_store_for_delayed_requeue
                .update_status(&task_id_for_delayed_requeue, "pending")
                .await
            {
                error!(
                    task_id = %task_id_for_delayed_requeue,
                    error = %status_error,
                    "failed to set task back to pending after retry backoff"
                );
            } else {
                info!(
                    task_id = %task_id_for_delayed_requeue,
                    "task re-queued as pending after retry backoff"
                );
            }
        });
    }

    async fn check_active_workers(&self) {
        let active_task_ids: Vec<String> = self
            .active_workers
            .iter()
            .map(|entry| entry.key().clone())
            .collect();

        for task_id in &active_task_ids {
            if let Some(task) = self.task_store.get_task(task_id).await
                && task.status == "cancelled"
            {
                info!(
                    task_id = %task_id,
                    "killing worker for cancelled task"
                );
                if let Some(mut worker_entry) = self.active_workers.remove(task_id) {
                    worker_entry.1.kill_process();
                    self.heartbeat_tracker.remove_tracking(task_id);
                }
            }
        }

        let stale_task_ids = self.heartbeat_tracker.get_stale_task_ids();
        for stale_task_id in &stale_task_ids {
            if let Some(mut worker_entry) = self.active_workers.remove(stale_task_id) {
                warn!(
                    task_id = %stale_task_id,
                    pid = worker_entry.1.process_id(),
                    "killing worker due to heartbeat timeout"
                );

                let stale_worker_working_directory =
                    worker_entry.1.working_directory().to_string();
                worker_entry.1.kill_process();
                self.heartbeat_tracker.remove_tracking(stale_task_id);

                if let Err(update_error) = self
                    .task_store
                    .update_result(
                        stale_task_id,
                        HEARTBEAT_TIMEOUT_EXIT_CODE,
                        None,
                        Some("killed by daemon: heartbeat timeout"),
                        None,
                    )
                    .await
                {
                    error!(
                        task_id = %stale_task_id,
                        error = %update_error,
                        "failed to update result for timed-out task"
                    );
                }

                if let Err(status_error) = self
                    .task_store
                    .update_status(stale_task_id, "failed")
                    .await
                {
                    error!(
                        task_id = %stale_task_id,
                        error = %status_error,
                        "failed to update status for timed-out task"
                    );
                }

                self.fire_notification_for_completed_worker(
                    stale_task_id,
                    HEARTBEAT_TIMEOUT_EXIT_CODE,
                )
                .await;

                self.schedule_retry_for_failed_task(
                    stale_task_id,
                    HEARTBEAT_TIMEOUT_EXIT_CODE,
                    &stale_worker_working_directory,
                )
                .await;
            }
        }

        let remaining_task_ids: Vec<String> = self
            .active_workers
            .iter()
            .map(|entry| entry.key().clone())
            .collect();

        for task_id in &remaining_task_ids {
            let exit_code = {
                if let Some(mut worker_entry) = self.active_workers.get_mut(task_id) {
                    worker_entry.try_get_exit_code()
                } else {
                    continue;
                }
            };

            if let Some(exit_code) = exit_code
                && let Some((_removed_task_id, removed_worker)) =
                    self.active_workers.remove(task_id)
            {
                self.heartbeat_tracker.remove_tracking(task_id);

                let final_status = if exit_code == 0 { "completed" } else { "failed" };

                info!(
                    task_id = %task_id,
                    exit_code = exit_code,
                    status = final_status,
                    "worker exited"
                );

                if let Err(result_error) = self
                    .task_store
                    .update_result(task_id, exit_code, None, None, None)
                    .await
                {
                    error!(
                        task_id = %task_id,
                        error = %result_error,
                        "failed to update result for exited worker"
                    );
                }

                if let Err(status_error) = self
                    .task_store
                    .update_status(task_id, final_status)
                    .await
                {
                    error!(
                        task_id = %task_id,
                        error = %status_error,
                        "failed to update status for exited worker"
                    );
                }

                let worker_working_directory = removed_worker.working_directory().to_string();

                self.fire_notification_for_completed_worker(task_id, exit_code)
                    .await;

                if exit_code != 0 {
                    self.schedule_retry_for_failed_task(
                        task_id,
                        exit_code,
                        &worker_working_directory,
                    )
                    .await;
                }

                self.cleanup_worktree_after_worker_exit(
                    task_id,
                    exit_code,
                    &worker_working_directory,
                );
            }
        }
    }

    fn cleanup_worktree_after_worker_exit(
        &self,
        task_id: &str,
        exit_code: i32,
        worker_working_directory: &str,
    ) {
        if worker_working_directory == self.repository_directory {
            return;
        }

        let worktree_path = PathBuf::from(worker_working_directory);

        if exit_code == 0 {
            info!(
                task_id = %task_id,
                worktree_path = %worktree_path.display(),
                "removing worktree after successful task completion"
            );

            let worktree_manager_for_removal = Arc::clone(&self.worktree_manager);
            tokio::task::spawn_blocking(move || {
                if let Err(removal_error) =
                    worktree_manager_for_removal.remove_worktree(&worktree_path)
                {
                    warn!(
                        worktree_path = %worktree_path.display(),
                        error = %removal_error,
                        "failed to remove worktree after successful task"
                    );
                }
            });
        } else {
            warn!(
                task_id = %task_id,
                exit_code = exit_code,
                worktree_path = %worktree_path.display(),
                "keeping worktree for debugging after failed task"
            );
        }
    }

    async fn spawn_worker_for_task(&self, task_id: &str, task_name: &str) {
        info!(
            task_id = task_id,
            task_name = task_name,
            "spawning worker for task"
        );

        let worker_directory = match self.worktree_manager.create_worktree(task_id, task_name) {
            Ok(worktree_info) => worktree_info
                .worktree_path
                .to_string_lossy()
                .to_string(),
            Err(worktree_creation_error) => {
                warn!(
                    task_id = task_id,
                    error = %worktree_creation_error,
                    "failed to create worktree, falling back to repository directory"
                );
                self.repository_directory.clone()
            }
        };

        let worker_result = WorkerProcess::spawn(
            task_id,
            &worker_directory,
            &self.daemon_url,
            &self.worker_script_path,
        );

        match worker_result {
            Ok(worker_process) => {
                let worker_process_id = worker_process.process_id() as i64;

                self.heartbeat_tracker.record_heartbeat(task_id);

                if let Err(status_error) = self
                    .task_store
                    .update_status(task_id, "running")
                    .await
                {
                    error!(
                        task_id = task_id,
                        error = %status_error,
                        "failed to update task status to running"
                    );
                }

                if let Err(worker_info_error) = self
                    .task_store
                    .update_worker_info(task_id, worker_process_id, &worker_directory)
                    .await
                {
                    error!(
                        task_id = task_id,
                        error = %worker_info_error,
                        "failed to update worker info"
                    );
                }

                self.active_workers
                    .insert(task_id.to_string(), worker_process);

                info!(
                    task_id = task_id,
                    pid = worker_process_id,
                    working_directory = %worker_directory,
                    active_count = self.active_workers.len(),
                    "worker spawned and tracking started"
                );

                self.fire_notification(NotificationEvent {
                    event_type: NotificationEventType::TaskStarted,
                    task_name: task_name.to_string(),
                    task_id: task_id.to_string(),
                    summary: format!("Task '{}' has started", task_name),
                    details: HashMap::new(),
                    timestamp: chrono::Utc::now(),
                });
            }
            Err(spawn_error) => {
                error!(
                    task_id = task_id,
                    task_name = task_name,
                    error = %spawn_error,
                    "failed to spawn worker"
                );

                if let Err(result_error) = self
                    .task_store
                    .update_result(task_id, 1, None, Some(&spawn_error), None)
                    .await
                {
                    error!(
                        task_id = task_id,
                        error = %result_error,
                        "failed to update result for spawn failure"
                    );
                }

                if let Err(status_error) = self
                    .task_store
                    .update_status(task_id, "failed")
                    .await
                {
                    error!(
                        task_id = task_id,
                        error = %status_error,
                        "failed to update status for spawn failure"
                    );
                }
            }
        }
    }

    async fn shutdown_all_workers(&self) {
        let active_count = self.active_workers.len();

        if active_count == 0 {
            info!("no active workers to shut down");
            return;
        }

        info!(
            active_count = active_count,
            "shutting down all active workers"
        );

        let all_task_ids: Vec<String> = self
            .active_workers
            .iter()
            .map(|entry| entry.key().clone())
            .collect();

        for task_id in &all_task_ids {
            if let Some(mut worker_entry) = self.active_workers.remove(task_id) {
                info!(
                    task_id = %task_id,
                    pid = worker_entry.1.process_id(),
                    "killing worker during shutdown"
                );
                worker_entry.1.kill_process();
                self.heartbeat_tracker.remove_tracking(task_id);
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        info!("all workers shut down");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    use std::path::PathBuf;
    use uuid::Uuid;

    async fn create_test_task_store() -> (Arc<TaskStore>, PathBuf) {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory.join(format!(
            "kraken_test_orchestrator_{}.sqlite",
            Uuid::new_v4()
        ));

        let database_pool =
            db::open_database(&database_path).expect("should open test database");

        let task_store = Arc::new(TaskStore::new(database_pool));
        (task_store, database_path)
    }

    fn create_empty_notification_dispatcher() -> Arc<NotificationDispatcher> {
        Arc::new(NotificationDispatcher::new())
    }

    #[tokio::test]
    async fn test_orchestrator_creation() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store,
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        assert_eq!(orchestrator.active_worker_count(), 0);
        assert_eq!(orchestrator.max_concurrent_workers, 3);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_get_heartbeat_tracker_returns_shared_arc() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store,
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let heartbeat_tracker = orchestrator.get_heartbeat_tracker();
        heartbeat_tracker.record_heartbeat("test-task");
        assert!(heartbeat_tracker.is_worker_alive("test-task"));

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_orchestrator_shutdown_with_no_workers() {
        let (task_store, database_path) = create_test_task_store().await;
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);

        let mut orchestrator = Orchestrator::new(
            task_store,
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        shutdown_sender.send(true).unwrap();

        orchestrator.run().await;

        assert_eq!(orchestrator.active_worker_count(), 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_tick_does_not_spawn_when_at_capacity() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let mut orchestrator = Orchestrator::new(
            task_store.clone(),
            0,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        task_store
            .create_task("test-task", "test description", 5)
            .await
            .expect("should create task");

        orchestrator.tick().await;
        assert_eq!(orchestrator.active_worker_count(), 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_spawn_worker_marks_task_failed_on_spawn_error() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/nonexistent/impossible/path".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let created_task = task_store
            .create_task("will-fail", "this task should fail to spawn", 5)
            .await
            .expect("should create task");

        orchestrator
            .spawn_worker_for_task(&created_task.id, &created_task.name)
            .await;

        let updated_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(updated_task.status, "failed");
        assert!(updated_task.error_message.is_some());
        assert_eq!(updated_task.exit_code, Some(1));

        assert_eq!(orchestrator.active_worker_count(), 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_check_active_workers_handles_cancelled_task() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            ".".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let created_task = task_store
            .create_task("cancel-test", "will be cancelled", 5)
            .await
            .expect("should create task");
        task_store
            .update_status(&created_task.id, "cancelled")
            .await
            .unwrap();

        #[cfg(unix)]
        let dummy_child = std::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("should spawn dummy process");

        #[cfg(windows)]
        let dummy_child = std::process::Command::new("cmd")
            .args(["/C", "timeout /t 60 /nobreak"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("should spawn dummy process");

        let dummy_worker = WorkerProcess {
            task_id: created_task.id.clone(),
            child_process: dummy_child,
            working_directory: ".".to_string(),
        };

        orchestrator
            .active_workers
            .insert(created_task.id.clone(), dummy_worker);
        orchestrator
            .heartbeat_tracker
            .record_heartbeat(&created_task.id);

        assert_eq!(orchestrator.active_worker_count(), 1);

        orchestrator.check_active_workers().await;

        assert_eq!(orchestrator.active_worker_count(), 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_check_active_workers_handles_stale_heartbeat() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            0,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            ".".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let created_task = task_store
            .create_task("stale-test", "will go stale", 5)
            .await
            .expect("should create task");
        task_store
            .update_status(&created_task.id, "running")
            .await
            .unwrap();

        #[cfg(unix)]
        let dummy_child = std::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("should spawn dummy process");

        #[cfg(windows)]
        let dummy_child = std::process::Command::new("cmd")
            .args(["/C", "timeout /t 60 /nobreak"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("should spawn dummy process");

        let dummy_worker = WorkerProcess {
            task_id: created_task.id.clone(),
            child_process: dummy_child,
            working_directory: ".".to_string(),
        };

        orchestrator
            .active_workers
            .insert(created_task.id.clone(), dummy_worker);
        orchestrator
            .heartbeat_tracker
            .record_heartbeat(&created_task.id);

        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

        orchestrator.check_active_workers().await;

        assert_eq!(orchestrator.active_worker_count(), 0);

        let updated_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        // Exit code 10 is retryable, so the task transitions to "retrying" instead of "failed"
        assert_eq!(updated_task.status, "retrying");
        assert_eq!(updated_task.exit_code, Some(HEARTBEAT_TIMEOUT_EXIT_CODE));
        assert!(updated_task
            .error_message
            .as_deref()
            .unwrap_or("")
            .contains("heartbeat timeout"));

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_cleanup_worktree_after_successful_worker_skips_repository_directory() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store,
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        // When worker_working_directory matches repository_directory, no cleanup should happen
        orchestrator.cleanup_worktree_after_worker_exit(
            "test-task-id",
            0,
            "/tmp/test-repo",
        );

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_retry_on_retryable_exit_code_1() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            300,
            2,
            0,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let created_task = task_store
            .create_task("retry-test", "will be retried", 5)
            .await
            .expect("should create task");

        task_store
            .update_result(&created_task.id, 1, None, Some("agent crashed"), None)
            .await
            .unwrap();
        task_store
            .update_status(&created_task.id, "failed")
            .await
            .unwrap();

        orchestrator
            .schedule_retry_for_failed_task(&created_task.id, 1, "/tmp/test-repo")
            .await;

        let retrying_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(retrying_task.attempt, 2);
        assert!(retrying_task
            .error_message
            .as_deref()
            .unwrap_or("")
            .contains("Previous attempt 1 failed"));

        // With 0 backoff, the spawned task should resolve quickly
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        let requeued_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(requeued_task.status, "pending");

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_no_retry_on_non_retryable_exit_code_2() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            300,
            2,
            0,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let created_task = task_store
            .create_task("no-retry-test", "agent gave up", 5)
            .await
            .expect("should create task");

        task_store
            .update_result(&created_task.id, 2, None, Some("agent gave up"), None)
            .await
            .unwrap();
        task_store
            .update_status(&created_task.id, "failed")
            .await
            .unwrap();

        orchestrator
            .schedule_retry_for_failed_task(&created_task.id, 2, "/tmp/test-repo")
            .await;

        let unchanged_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(unchanged_task.status, "failed");
        assert_eq!(unchanged_task.attempt, 1);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_max_retries_exhausted_does_not_retry() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            300,
            2,
            0,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let created_task = task_store
            .create_task("exhausted-retry-test", "will exhaust retries", 5)
            .await
            .expect("should create task");

        // Simulate having already been retried twice (attempt=3 means third try with max_retries=2)
        task_store.increment_attempt(&created_task.id).await.unwrap();
        task_store.increment_attempt(&created_task.id).await.unwrap();

        task_store
            .update_result(&created_task.id, 1, None, Some("crashed again"), None)
            .await
            .unwrap();
        task_store
            .update_status(&created_task.id, "failed")
            .await
            .unwrap();

        orchestrator
            .schedule_retry_for_failed_task(&created_task.id, 1, "/tmp/test-repo")
            .await;

        let exhausted_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(exhausted_task.status, "failed");
        assert_eq!(exhausted_task.attempt, 3);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_increment_attempt_increases_counter() {
        let (task_store, database_path) = create_test_task_store().await;

        let created_task = task_store
            .create_task("attempt-test", "testing attempts", 5)
            .await
            .expect("should create task");

        assert_eq!(created_task.attempt, 1);

        task_store.increment_attempt(&created_task.id).await.unwrap();

        let updated_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(updated_task.attempt, 2);

        task_store.increment_attempt(&created_task.id).await.unwrap();

        let updated_task_again = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(updated_task_again.attempt, 3);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_retry_on_heartbeat_timeout_exit_code_10() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            300,
            2,
            0,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let created_task = task_store
            .create_task("timeout-retry-test", "killed by daemon", 5)
            .await
            .expect("should create task");

        task_store
            .update_result(
                &created_task.id,
                HEARTBEAT_TIMEOUT_EXIT_CODE,
                None,
                Some("killed by daemon: heartbeat timeout"),
                None,
            )
            .await
            .unwrap();
        task_store
            .update_status(&created_task.id, "failed")
            .await
            .unwrap();

        orchestrator
            .schedule_retry_for_failed_task(
                &created_task.id,
                HEARTBEAT_TIMEOUT_EXIT_CODE,
                "/tmp/test-repo",
            )
            .await;

        let retrying_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(retrying_task.attempt, 2);
        assert!(retrying_task
            .error_message
            .as_deref()
            .unwrap_or("")
            .contains("heartbeat timeout"));

        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        let requeued_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(requeued_task.status, "pending");

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_no_retry_on_exit_code_3_bad_input() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            300,
            2,
            0,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        let created_task = task_store
            .create_task("bad-input-test", "bad input", 5)
            .await
            .expect("should create task");

        task_store
            .update_result(&created_task.id, 3, None, Some("bad input provided"), None)
            .await
            .unwrap();
        task_store
            .update_status(&created_task.id, "failed")
            .await
            .unwrap();

        orchestrator
            .schedule_retry_for_failed_task(&created_task.id, 3, "/tmp/test-repo")
            .await;

        let unchanged_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(unchanged_task.status, "failed");
        assert_eq!(unchanged_task.attempt, 1);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_daily_digest_notification_fires_with_statistics() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let completed_task = task_store
            .create_task("digest-completed", "desc", 5)
            .await
            .unwrap();
        task_store
            .update_status(&completed_task.id, "running")
            .await
            .unwrap();
        task_store
            .add_token_usage(&completed_task.id, 500, 200, 0.025)
            .await
            .unwrap();
        task_store
            .update_status(&completed_task.id, "completed")
            .await
            .unwrap();

        let failed_task = task_store
            .create_task("digest-failed", "desc", 5)
            .await
            .unwrap();
        task_store
            .update_status(&failed_task.id, "running")
            .await
            .unwrap();
        task_store
            .add_token_usage(&failed_task.id, 100, 50, 0.005)
            .await
            .unwrap();
        task_store
            .update_status(&failed_task.id, "failed")
            .await
            .unwrap();

        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        orchestrator.fire_daily_digest_notification().await;

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_daily_digest_notification_fires_with_zero_statistics() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store,
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        orchestrator.fire_daily_digest_notification().await;

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_daily_digest_tick_counter_increments_and_resets() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let mut orchestrator = Orchestrator::new(
            task_store,
            3,
            300,
            2,
            30,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
            create_empty_notification_dispatcher(),
        );

        assert_eq!(orchestrator.ticks_since_last_daily_digest, 0);

        orchestrator.ticks_since_last_daily_digest = DAILY_DIGEST_INTERVAL_TICKS - 2;
        orchestrator.tick().await;
        assert_eq!(
            orchestrator.ticks_since_last_daily_digest,
            DAILY_DIGEST_INTERVAL_TICKS - 1
        );

        orchestrator.tick().await;
        assert_eq!(orchestrator.ticks_since_last_daily_digest, 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_daily_digest_event_format_contains_expected_details() {
        use crate::db::tasks::DailyStatistics;

        let daily_statistics = DailyStatistics {
            completed_task_count: 5,
            failed_task_count: 2,
            total_cost_usd: 1.2345,
            total_prompt_tokens: 10000,
            total_completion_tokens: 5000,
        };

        let total_token_count =
            daily_statistics.total_prompt_tokens + daily_statistics.total_completion_tokens;

        let mut daily_digest_details = HashMap::new();
        daily_digest_details.insert(
            "completed".to_string(),
            daily_statistics.completed_task_count.to_string(),
        );
        daily_digest_details.insert(
            "failed".to_string(),
            daily_statistics.failed_task_count.to_string(),
        );
        daily_digest_details.insert(
            "total_cost_usd".to_string(),
            format!("${:.4}", daily_statistics.total_cost_usd),
        );
        daily_digest_details.insert(
            "total_tokens".to_string(),
            total_token_count.to_string(),
        );

        let digest_event = NotificationEvent {
            event_type: NotificationEventType::DailyDigest,
            task_name: "daily-digest".to_string(),
            task_id: "daily-digest".to_string(),
            summary: format!(
                "Daily digest: {} completed, {} failed, {} tokens, ${:.4} cost",
                daily_statistics.completed_task_count,
                daily_statistics.failed_task_count,
                total_token_count,
                daily_statistics.total_cost_usd,
            ),
            details: daily_digest_details,
            timestamp: chrono::Utc::now(),
        };

        let formatted_text = digest_event.format_as_plain_text();

        assert!(formatted_text.contains("DailyDigest"));
        assert!(formatted_text.contains("5 completed, 2 failed, 15000 tokens, $1.2345 cost"));
        assert!(formatted_text.contains("completed: 5"));
        assert!(formatted_text.contains("failed: 2"));
        assert!(formatted_text.contains("total_cost_usd: $1.2345"));
        assert!(formatted_text.contains("total_tokens: 15000"));
    }
}
