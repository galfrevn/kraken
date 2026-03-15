pub mod heartbeat;
pub mod worker;
pub mod worktree;

use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::watch;
use tracing::{error, info, warn};

use crate::db::tasks::TaskStore;
use heartbeat::HeartbeatTracker;
use worker::WorkerProcess;

/// Exit code assigned to tasks killed due to heartbeat timeout.
/// This distinguishes daemon-initiated kills from normal worker failures.
const HEARTBEAT_TIMEOUT_EXIT_CODE: i32 = 10;

/// The task orchestrator is the central loop that manages the lifecycle of
/// worker subprocesses. It runs as a tokio task in the background, polling
/// every second to:
///
/// 1. Kill workers whose tasks have been cancelled.
/// 2. Kill workers that have exceeded the heartbeat timeout.
/// 3. Collect results from workers that have exited.
/// 4. Spawn new workers for pending tasks (up to the concurrency limit).
pub struct Orchestrator {
    task_store: Arc<TaskStore>,
    heartbeat_tracker: Arc<HeartbeatTracker>,
    active_workers: Arc<DashMap<String, WorkerProcess>>,
    max_concurrent_workers: u32,
    daemon_url: String,
    worker_script_path: String,
    repository_directory: String,
    shutdown_receiver: watch::Receiver<bool>,
}

impl Orchestrator {
    /// Creates a new orchestrator with the given configuration.
    ///
    /// - `task_store`: shared access to the SQLite-backed task table.
    /// - `max_concurrent_workers`: upper bound on simultaneously running workers.
    /// - `heartbeat_timeout_seconds`: seconds of silence before a worker is killed.
    /// - `daemon_url`: the gRPC URL workers use to call back into the daemon.
    /// - `worker_script_path`: path to the TypeScript worker entry point.
    /// - `repository_directory`: the repo root where workers run (Phase 1: no worktrees).
    /// - `shutdown_receiver`: watch channel that signals graceful shutdown.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        task_store: Arc<TaskStore>,
        max_concurrent_workers: u32,
        heartbeat_timeout_seconds: u64,
        daemon_url: String,
        worker_script_path: String,
        repository_directory: String,
        shutdown_receiver: watch::Receiver<bool>,
    ) -> Self {
        let heartbeat_tracker = Arc::new(HeartbeatTracker::new(heartbeat_timeout_seconds));

        info!(
            max_concurrent_workers = max_concurrent_workers,
            heartbeat_timeout_seconds = heartbeat_timeout_seconds,
            repository_directory = %repository_directory,
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
            shutdown_receiver,
        }
    }

    /// Returns a clone of the heartbeat tracker Arc, so gRPC services
    /// can record heartbeats from worker callbacks.
    pub fn get_heartbeat_tracker(&self) -> Arc<HeartbeatTracker> {
        Arc::clone(&self.heartbeat_tracker)
    }

    /// Returns the number of workers currently running.
    pub fn active_worker_count(&self) -> usize {
        self.active_workers.len()
    }

    /// The main orchestrator loop. Runs until the shutdown signal is received.
    ///
    /// On each tick (every second), the orchestrator:
    /// 1. Checks for cancelled tasks and kills their workers.
    /// 2. Checks for stale heartbeats and kills timed-out workers.
    /// 3. Collects results from exited workers.
    /// 4. Spawns new workers for pending tasks if capacity allows.
    ///
    /// When the shutdown signal arrives, all active workers are killed
    /// before the loop exits.
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

    /// Performs a single orchestration cycle. Called once per second by `run()`.
    async fn tick(&mut self) {
        self.check_active_workers().await;

        // Spawn new workers if we have capacity and pending tasks
        let current_worker_count = self.active_workers.len() as u32;
        if current_worker_count < self.max_concurrent_workers
            && let Some(pending_task) = self.task_store.get_next_pending_task().await
        {
            self.spawn_worker_for_task(&pending_task.id, &pending_task.name)
                .await;
        }
    }

    /// Checks all active workers for three conditions:
    ///
    /// 1. **Cancelled tasks**: queries the task store for each worker's task
    ///    status and kills workers whose tasks have been set to "cancelled".
    /// 2. **Stale heartbeats**: identifies workers that have not sent a
    ///    heartbeat within the timeout window and kills them, marking the
    ///    task as failed with exit code 10.
    /// 3. **Exited workers**: collects the exit code from workers that have
    ///    finished and updates the task status accordingly.
    async fn check_active_workers(&self) {
        // Collect task IDs first to avoid holding DashMap references across await points
        let active_task_ids: Vec<String> = self
            .active_workers
            .iter()
            .map(|entry| entry.key().clone())
            .collect();

        // 1. Check for cancelled tasks
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

        // 2. Check for stale heartbeats
        let stale_task_ids = self.heartbeat_tracker.get_stale_task_ids();
        for stale_task_id in &stale_task_ids {
            // Only act on tasks that are still in our active workers map
            if let Some(mut worker_entry) = self.active_workers.remove(stale_task_id) {
                warn!(
                    task_id = %stale_task_id,
                    pid = worker_entry.1.process_id(),
                    "killing worker due to heartbeat timeout"
                );

                worker_entry.1.kill_process();
                self.heartbeat_tracker.remove_tracking(stale_task_id);

                // Mark task as failed with the heartbeat timeout exit code
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

        // 3. Check for exited workers — re-collect IDs since some may have been removed above
        let remaining_task_ids: Vec<String> = self
            .active_workers
            .iter()
            .map(|entry| entry.key().clone())
            .collect();

        for task_id in &remaining_task_ids {
            // We need mutable access to check exit code, so remove temporarily
            let exit_code = {
                if let Some(mut worker_entry) = self.active_workers.get_mut(task_id) {
                    worker_entry.try_get_exit_code()
                } else {
                    continue;
                }
            };

            if let Some(exit_code) = exit_code {
                // Worker has exited — remove it from active workers
                if let Some((_removed_task_id, _removed_worker)) =
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
                }
            }
        }
    }

    /// Spawns a new worker subprocess for the given task. Updates the task
    /// status to "running" and records the worker PID and working directory
    /// in the task store. Also registers the initial heartbeat so the worker
    /// has a full timeout window before being considered stale.
    async fn spawn_worker_for_task(&self, task_id: &str, task_name: &str) {
        info!(
            task_id = task_id,
            task_name = task_name,
            "spawning worker for task"
        );

        let worker_result = WorkerProcess::spawn(
            task_id,
            &self.repository_directory,
            &self.daemon_url,
            &self.worker_script_path,
        );

        match worker_result {
            Ok(worker_process) => {
                let worker_process_id = worker_process.process_id() as i64;

                // Record initial heartbeat so the worker has a full timeout window
                self.heartbeat_tracker.record_heartbeat(task_id);

                // Update task status to running
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

                // Record worker info (PID and working directory)
                if let Err(worker_info_error) = self
                    .task_store
                    .update_worker_info(task_id, worker_process_id, &self.repository_directory)
                    .await
                {
                    error!(
                        task_id = task_id,
                        error = %worker_info_error,
                        "failed to update worker info"
                    );
                }

                // Track the worker in the active workers map
                self.active_workers
                    .insert(task_id.to_string(), worker_process);

                info!(
                    task_id = task_id,
                    pid = worker_process_id,
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

                // Mark task as failed since we could not start it
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

    /// Kills all active workers and waits briefly for them to exit.
    /// Called during graceful shutdown to ensure no orphaned subprocesses
    /// remain after the daemon stops.
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

        // Collect all task IDs and remove + kill each worker
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

        // Give workers a brief moment to clean up
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

    /// Creates an in-memory-like test TaskStore with a unique temporary database.
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
            shutdown_receiver,
        );

        // Send shutdown immediately
        shutdown_sender.send(true).unwrap();

        // run() should exit promptly
        orchestrator.run().await;

        assert_eq!(orchestrator.active_worker_count(), 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_tick_does_not_spawn_when_at_capacity() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        // Set max_concurrent_workers to 0 so no workers can spawn
        let mut orchestrator = Orchestrator::new(
            task_store.clone(),
            0,
            300,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            "/tmp/test-repo".to_string(),
            shutdown_receiver,
        );

        // Create a pending task
        task_store
            .create_task("test-task", "test description", 5)
            .await
            .expect("should create task");

        // Tick should not spawn because max is 0
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
            // Use an invalid directory so spawn fails
            "/nonexistent/impossible/path".to_string(),
            shutdown_receiver,
        );

        let created_task = task_store
            .create_task("will-fail", "this task should fail to spawn", 5)
            .await
            .expect("should create task");

        orchestrator
            .spawn_worker_for_task(&created_task.id, &created_task.name)
            .await;

        // The task should be marked as failed
        let updated_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("task should exist");
        assert_eq!(updated_task.status, "failed");
        assert!(updated_task.error_message.is_some());
        assert_eq!(updated_task.exit_code, Some(1));

        // No worker should be active
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
            shutdown_receiver,
        );

        // Create a task and mark it as cancelled
        let created_task = task_store
            .create_task("cancel-test", "will be cancelled", 5)
            .await
            .expect("should create task");
        task_store
            .update_status(&created_task.id, "cancelled")
            .await
            .unwrap();

        // Simulate an active worker by inserting a dummy process
        // We use a real process (on both Unix and Windows) so kill_process doesn't panic
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

        // check_active_workers should detect the cancelled task and kill the worker
        orchestrator.check_active_workers().await;

        assert_eq!(orchestrator.active_worker_count(), 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_check_active_workers_handles_stale_heartbeat() {
        let (task_store, database_path) = create_test_task_store().await;
        let (_shutdown_sender, shutdown_receiver) = watch::channel(false);

        // Use 0-second timeout so heartbeat is immediately stale
        let orchestrator = Orchestrator::new(
            task_store.clone(),
            3,
            0,
            "http://localhost:50051".to_string(),
            "worker.ts".to_string(),
            ".".to_string(),
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

        // Spawn a real dummy process
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

        // Wait a moment so the heartbeat becomes stale (timeout is 0 seconds)
        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

        orchestrator.check_active_workers().await;

        assert_eq!(orchestrator.active_worker_count(), 0);

        // Task should be marked as failed with heartbeat timeout exit code
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
}
