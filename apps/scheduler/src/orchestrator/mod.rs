pub mod heartbeat;
pub mod worker;
pub mod worktree;

use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::db::tasks::TaskStore;
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

pub struct Orchestrator {
    task_store: Arc<TaskStore>,
    heartbeat_tracker: Arc<HeartbeatTracker>,
    active_workers: Arc<DashMap<String, WorkerProcess>>,
    max_concurrent_workers: u32,
    daemon_url: String,
    worker_script_path: String,
    repository_directory: String,
    worktree_manager: Arc<WorktreeManager>,
    shutdown_receiver: watch::Receiver<bool>,
    ticks_since_last_stale_worktree_cleanup: u64,
}

impl Orchestrator {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        task_store: Arc<TaskStore>,
        max_concurrent_workers: u32,
        heartbeat_timeout_seconds: u64,
        daemon_url: String,
        worker_script_path: String,
        repository_directory: String,
        branch_prefix: String,
        shutdown_receiver: watch::Receiver<bool>,
    ) -> Self {
        let heartbeat_tracker = Arc::new(HeartbeatTracker::new(heartbeat_timeout_seconds));
        let worktree_manager = Arc::new(WorktreeManager::new(
            &PathBuf::from(&repository_directory),
            &branch_prefix,
        ));

        info!(
            max_concurrent_workers = max_concurrent_workers,
            heartbeat_timeout_seconds = heartbeat_timeout_seconds,
            repository_directory = %repository_directory,
            branch_prefix = %branch_prefix,
            "orchestrator created"
        );

        Self {
            task_store,
            heartbeat_tracker,
            active_workers: Arc::new(DashMap::new()),
            max_concurrent_workers,
            daemon_url,
            worker_script_path,
            repository_directory,
            worktree_manager,
            shutdown_receiver,
            ticks_since_last_stale_worktree_cleanup: 0,
        }
    }

    pub fn get_heartbeat_tracker(&self) -> Arc<HeartbeatTracker> {
        Arc::clone(&self.heartbeat_tracker)
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

    #[tokio::test]
    async fn test_orchestrator_creation() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        let orchestrator = Orchestrator::new(
            task_store,
            3,
            300,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
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
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
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
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
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
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
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
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/nonexistent/impossible/path".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
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
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            ".".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
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
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            ".".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
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
        assert_eq!(updated_task.status, "failed");
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
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            "kraken/".to_string(),
            shutdown_receiver,
        );

        // When worker_working_directory matches repository_directory, no cleanup should happen
        orchestrator.cleanup_worktree_after_worker_exit(
            "test-task-id",
            0,
            "/tmp/test-repo",
        );

        let _ = std::fs::remove_file(&database_path);
    }
}
