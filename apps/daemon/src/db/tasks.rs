use rusqlite::{Row, params};
use uuid::Uuid;

use super::DatabasePool;

/// Represents a single row from the `daemon_tasks` table.
/// Optional fields correspond to nullable columns in SQLite.
#[derive(Debug, Clone)]
pub struct DaemonTask {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub priority: i32,
    pub trigger_id: Option<String>,
    pub trigger_type: Option<String>,
    pub trigger_payload: Option<String>,
    pub worker_pid: Option<i64>,
    pub worker_dir: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
    pub timeout_ms: i64,
    pub exit_code: Option<i32>,
    pub output: Option<String>,
    pub error_message: Option<String>,
    pub artifacts: Option<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub estimated_cost_usd: f64,
    pub attempt: i32,
    pub max_retries: i32,
    pub created_at: String,
}

/// Converts a rusqlite Row into a DaemonTask using named column access.
fn row_to_daemon_task(row: &Row<'_>) -> rusqlite::Result<DaemonTask> {
    Ok(DaemonTask {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        status: row.get("status")?,
        priority: row.get("priority")?,
        trigger_id: row.get("trigger_id")?,
        trigger_type: row.get("trigger_type")?,
        trigger_payload: row.get("trigger_payload")?,
        worker_pid: row.get("worker_pid")?,
        worker_dir: row.get("worker_dir")?,
        started_at: row.get("started_at")?,
        completed_at: row.get("completed_at")?,
        updated_at: row.get("updated_at")?,
        timeout_ms: row.get("timeout_ms")?,
        exit_code: row.get("exit_code")?,
        output: row.get("output")?,
        error_message: row.get("error_message")?,
        artifacts: row.get("artifacts")?,
        prompt_tokens: row.get("prompt_tokens")?,
        completion_tokens: row.get("completion_tokens")?,
        estimated_cost_usd: row.get("estimated_cost_usd")?,
        attempt: row.get("attempt")?,
        max_retries: row.get("max_retries")?,
        created_at: row.get("created_at")?,
    })
}

#[derive(Debug, Clone, Default)]
pub struct DailyStatistics {
    pub completed_task_count: i32,
    pub failed_task_count: i32,
    pub total_cost_usd: f64,
    pub total_prompt_tokens: i64,
    pub total_completion_tokens: i64,
}

/// Provides CRUD operations for the `daemon_tasks` and `task_logs` tables.
/// The daemon is the sole writer; all mutations go through this store.
#[derive(Clone)]
pub struct TaskStore {
    database_pool: DatabasePool,
}

impl TaskStore {
    /// Creates a new TaskStore backed by the given database pool.
    pub fn new(database_pool: DatabasePool) -> Self {
        Self { database_pool }
    }

    /// Inserts a new task with the given name, description, and priority.
    /// Generates a UUID for the task ID and returns the fully-populated DaemonTask.
    pub async fn create_task(
        &self,
        name: &str,
        description: &str,
        priority: i32,
    ) -> Result<DaemonTask, String> {
        let task_id = Uuid::new_v4().to_string();
        let task_name = name.to_string();
        let task_description = description.to_string();

        let connection = self.database_pool.lock().await;

        connection
            .execute(
                "INSERT INTO daemon_tasks (id, name, description, priority)
                 VALUES (?1, ?2, ?3, ?4)",
                params![task_id, task_name, task_description, priority],
            )
            .map_err(|error| format!("failed to insert task: {error}"))?;

        let created_task = connection
            .query_row(
                "SELECT * FROM daemon_tasks WHERE id = ?1",
                params![task_id],
                row_to_daemon_task,
            )
            .map_err(|error| format!("failed to retrieve created task: {error}"))?;

        Ok(created_task)
    }

    /// Fetches a single task by its ID, returning None if not found.
    pub async fn get_task(&self, task_id: &str) -> Option<DaemonTask> {
        let connection = self.database_pool.lock().await;

        connection
            .query_row(
                "SELECT * FROM daemon_tasks WHERE id = ?1",
                params![task_id],
                row_to_daemon_task,
            )
            .ok()
    }

    /// Lists tasks with an optional status filter and a maximum row count.
    /// Tasks are ordered by priority (ascending = higher priority first) then by creation time.
    pub async fn list_tasks(
        &self,
        status_filter: Option<&str>,
        limit: i32,
    ) -> Vec<DaemonTask> {
        let connection = self.database_pool.lock().await;

        match status_filter {
            Some(status_value) => {
                let mut statement = connection
                    .prepare(
                        "SELECT * FROM daemon_tasks
                         WHERE status = ?1
                         ORDER BY priority ASC, created_at ASC
                         LIMIT ?2",
                    )
                    .unwrap_or_else(|error| panic!("failed to prepare list_tasks query: {error}"));

                statement
                    .query_map(params![status_value, limit], row_to_daemon_task)
                    .unwrap_or_else(|error| panic!("failed to execute list_tasks query: {error}"))
                    .filter_map(|result| result.ok())
                    .collect()
            }
            None => {
                let mut statement = connection
                    .prepare(
                        "SELECT * FROM daemon_tasks
                         ORDER BY priority ASC, created_at ASC
                         LIMIT ?1",
                    )
                    .unwrap_or_else(|error| panic!("failed to prepare list_tasks query: {error}"));

                statement
                    .query_map(params![limit], row_to_daemon_task)
                    .unwrap_or_else(|error| panic!("failed to execute list_tasks query: {error}"))
                    .filter_map(|result| result.ok())
                    .collect()
            }
        }
    }

    /// Returns the highest-priority pending task (lowest priority number = highest priority).
    /// Among tasks with equal priority, the oldest task is selected first.
    pub async fn get_next_pending_task(&self) -> Option<DaemonTask> {
        let connection = self.database_pool.lock().await;

        connection
            .query_row(
                "SELECT * FROM daemon_tasks
                 WHERE status = 'pending'
                 ORDER BY priority ASC, created_at ASC
                 LIMIT 1",
                [],
                row_to_daemon_task,
            )
            .ok()
    }

    /// Updates a task's status and automatically sets timestamp side effects:
    /// - "running" sets `started_at` to the current time
    /// - "completed", "failed", or "cancelled" sets `completed_at` to the current time
    /// All values are parameterized; no string interpolation of timestamps.
    pub async fn update_status(
        &self,
        task_id: &str,
        status: &str,
    ) -> Result<(), String> {
        let connection = self.database_pool.lock().await;

        let rows_affected = match status {
            "running" => {
                connection
                    .execute(
                        "UPDATE daemon_tasks
                         SET status = ?1,
                             started_at = datetime('now'),
                             updated_at = datetime('now')
                         WHERE id = ?2",
                        params![status, task_id],
                    )
                    .map_err(|error| format!("failed to update task status to running: {error}"))?
            }
            "completed" | "failed" | "cancelled" => {
                connection
                    .execute(
                        "UPDATE daemon_tasks
                         SET status = ?1,
                             completed_at = datetime('now'),
                             updated_at = datetime('now')
                         WHERE id = ?2",
                        params![status, task_id],
                    )
                    .map_err(|error| {
                        format!("failed to update task status to {status}: {error}")
                    })?
            }
            _ => {
                connection
                    .execute(
                        "UPDATE daemon_tasks
                         SET status = ?1,
                             updated_at = datetime('now')
                         WHERE id = ?2",
                        params![status, task_id],
                    )
                    .map_err(|error| format!("failed to update task status: {error}"))?
            }
        };

        if rows_affected == 0 {
            return Err(format!("no task found with id: {task_id}"));
        }

        Ok(())
    }

    /// Sets the worker process ID and working directory for a task.
    pub async fn update_worker_info(
        &self,
        task_id: &str,
        process_id: i64,
        worker_directory: &str,
    ) -> Result<(), String> {
        let connection = self.database_pool.lock().await;

        let rows_affected = connection
            .execute(
                "UPDATE daemon_tasks
                 SET worker_pid = ?1,
                     worker_dir = ?2,
                     updated_at = datetime('now')
                 WHERE id = ?3",
                params![process_id, worker_directory, task_id],
            )
            .map_err(|error| format!("failed to update worker info: {error}"))?;

        if rows_affected == 0 {
            return Err(format!("no task found with id: {task_id}"));
        }

        Ok(())
    }

    /// Records the result of a completed task: exit code, output, error message,
    /// and serialized artifacts JSON.
    pub async fn update_result(
        &self,
        task_id: &str,
        exit_code: i32,
        output: Option<&str>,
        error_message: Option<&str>,
        artifacts_json: Option<&str>,
    ) -> Result<(), String> {
        let connection = self.database_pool.lock().await;

        let rows_affected = connection
            .execute(
                "UPDATE daemon_tasks
                 SET exit_code = ?1,
                     output = ?2,
                     error_message = ?3,
                     artifacts = ?4,
                     updated_at = datetime('now')
                 WHERE id = ?5",
                params![exit_code, output, error_message, artifacts_json, task_id],
            )
            .map_err(|error| format!("failed to update task result: {error}"))?;

        if rows_affected == 0 {
            return Err(format!("no task found with id: {task_id}"));
        }

        Ok(())
    }

    /// Increments the token usage counters and estimated cost for a task.
    /// Values are added to the existing totals, not replaced.
    pub async fn add_token_usage(
        &self,
        task_id: &str,
        prompt_tokens: i64,
        completion_tokens: i64,
        cost_usd: f64,
    ) -> Result<(), String> {
        let connection = self.database_pool.lock().await;

        let rows_affected = connection
            .execute(
                "UPDATE daemon_tasks
                 SET prompt_tokens = prompt_tokens + ?1,
                     completion_tokens = completion_tokens + ?2,
                     estimated_cost_usd = estimated_cost_usd + ?3,
                     updated_at = datetime('now')
                 WHERE id = ?4",
                params![prompt_tokens, completion_tokens, cost_usd, task_id],
            )
            .map_err(|error| format!("failed to add token usage: {error}"))?;

        if rows_affected == 0 {
            return Err(format!("no task found with id: {task_id}"));
        }

        Ok(())
    }

    /// Appends a log entry for a given task.
    pub async fn write_log(
        &self,
        task_id: &str,
        level: &str,
        message: &str,
    ) -> Result<(), String> {
        let connection = self.database_pool.lock().await;

        connection
            .execute(
                "INSERT INTO task_logs (task_id, level, message)
                 VALUES (?1, ?2, ?3)",
                params![task_id, level, message],
            )
            .map_err(|error| format!("failed to write task log: {error}"))?;

        Ok(())
    }

    /// Returns all log entries for a task as (level, message, created_at) tuples,
    /// ordered chronologically.
    pub async fn get_task_logs(
        &self,
        task_id: &str,
    ) -> Vec<(String, String, String)> {
        let connection = self.database_pool.lock().await;

        let mut statement = connection
            .prepare(
                "SELECT level, message, created_at FROM task_logs
                 WHERE task_id = ?1
                 ORDER BY created_at ASC",
            )
            .unwrap_or_else(|error| panic!("failed to prepare get_task_logs query: {error}"));

        statement
            .query_map(params![task_id], |row| {
                Ok((
                    row.get::<_, String>("level")?,
                    row.get::<_, String>("message")?,
                    row.get::<_, String>("created_at")?,
                ))
            })
            .unwrap_or_else(|error| panic!("failed to execute get_task_logs query: {error}"))
            .filter_map(|result| result.ok())
            .collect()
    }

    /// Counts the number of tasks completed (status = 'completed') today (UTC).
    pub async fn count_completed_today(&self) -> i32 {
        let connection = self.database_pool.lock().await;

        connection
            .query_row(
                "SELECT COUNT(*) FROM daemon_tasks
                 WHERE status = 'completed'
                   AND completed_at >= date('now')",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
    }

    pub async fn increment_attempt(
        &self,
        task_id: &str,
    ) -> Result<(), String> {
        let connection = self.database_pool.lock().await;

        let rows_affected = connection
            .execute(
                "UPDATE daemon_tasks
                 SET attempt = attempt + 1,
                     updated_at = datetime('now')
                 WHERE id = ?1",
                params![task_id],
            )
            .map_err(|error| format!("failed to increment attempt: {error}"))?;

        if rows_affected == 0 {
            return Err(format!("no task found with id: {task_id}"));
        }

        Ok(())
    }

    pub async fn set_retry_context(
        &self,
        task_id: &str,
        retry_context_message: &str,
    ) -> Result<(), String> {
        let connection = self.database_pool.lock().await;

        let rows_affected = connection
            .execute(
                "UPDATE daemon_tasks
                 SET error_message = ?1,
                     updated_at = datetime('now')
                 WHERE id = ?2",
                params![retry_context_message, task_id],
            )
            .map_err(|error| format!("failed to set retry context: {error}"))?;

        if rows_affected == 0 {
            return Err(format!("no task found with id: {task_id}"));
        }

        Ok(())
    }

    /// Counts the number of tasks with a given status.
    pub async fn count_by_status(&self, status: &str) -> i32 {
        let connection = self.database_pool.lock().await;

        connection
            .query_row(
                "SELECT COUNT(*) FROM daemon_tasks WHERE status = ?1",
                params![status],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
    }

    /// Aggregates task statistics for the current UTC day: completed/failed counts,
    /// total cost, and total token usage. Uses completed_at for terminal tasks and
    /// created_at as fallback for tasks without a completion timestamp.
    pub async fn get_daily_statistics(&self) -> DailyStatistics {
        let connection = self.database_pool.lock().await;

        let completed_task_count = connection
            .query_row(
                "SELECT COUNT(*) FROM daemon_tasks
                 WHERE status = 'completed'
                   AND date(COALESCE(completed_at, created_at)) = date('now')",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0);

        let failed_task_count = connection
            .query_row(
                "SELECT COUNT(*) FROM daemon_tasks
                 WHERE status = 'failed'
                   AND date(COALESCE(completed_at, created_at)) = date('now')",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0);

        let (total_cost_usd, total_prompt_tokens, total_completion_tokens) = connection
            .query_row(
                "SELECT COALESCE(SUM(estimated_cost_usd), 0.0),
                        COALESCE(SUM(prompt_tokens), 0),
                        COALESCE(SUM(completion_tokens), 0)
                 FROM daemon_tasks
                 WHERE date(COALESCE(completed_at, created_at)) = date('now')",
                [],
                |row| {
                    Ok((
                        row.get::<_, f64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap_or((0.0, 0, 0));

        DailyStatistics {
            completed_task_count,
            failed_task_count,
            total_cost_usd,
            total_prompt_tokens,
            total_completion_tokens,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;
    use std::path::PathBuf;

    async fn create_test_store() -> (TaskStore, PathBuf) {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory.join(format!(
            "kraken_test_tasks_{}.sqlite",
            Uuid::new_v4()
        ));

        let database_pool =
            open_database(&database_path).expect("should open test database");

        (TaskStore::new(database_pool), database_path)
    }

    #[tokio::test]
    async fn test_create_and_get_task() {
        let (task_store, database_path) = create_test_store().await;

        let created_task = task_store
            .create_task("test task", "a test description", 3)
            .await
            .expect("should create task");

        assert_eq!(created_task.name, "test task");
        assert_eq!(created_task.description, "a test description");
        assert_eq!(created_task.priority, 3);
        assert_eq!(created_task.status, "pending");

        let fetched_task = task_store
            .get_task(&created_task.id)
            .await
            .expect("should find created task");
        assert_eq!(fetched_task.id, created_task.id);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_list_tasks_with_filter() {
        let (task_store, database_path) = create_test_store().await;

        task_store.create_task("task one", "desc", 5).await.unwrap();
        task_store.create_task("task two", "desc", 3).await.unwrap();

        let all_tasks = task_store.list_tasks(None, 100).await;
        assert_eq!(all_tasks.len(), 2);

        // Lower priority number comes first
        assert_eq!(all_tasks[0].name, "task two");

        let pending_tasks = task_store.list_tasks(Some("pending"), 100).await;
        assert_eq!(pending_tasks.len(), 2);

        let running_tasks = task_store.list_tasks(Some("running"), 100).await;
        assert_eq!(running_tasks.len(), 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_get_next_pending_task() {
        let (task_store, database_path) = create_test_store().await;

        task_store.create_task("low priority", "desc", 10).await.unwrap();
        task_store.create_task("high priority", "desc", 1).await.unwrap();

        let next_task = task_store
            .get_next_pending_task()
            .await
            .expect("should find a pending task");
        assert_eq!(next_task.name, "high priority");

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_update_status_sets_timestamps() {
        let (task_store, database_path) = create_test_store().await;

        let task = task_store.create_task("task", "desc", 5).await.unwrap();
        assert!(task.started_at.is_none());
        assert!(task.completed_at.is_none());

        task_store.update_status(&task.id, "running").await.unwrap();
        let running_task = task_store.get_task(&task.id).await.unwrap();
        assert!(running_task.started_at.is_some());
        assert_eq!(running_task.status, "running");

        task_store.update_status(&task.id, "completed").await.unwrap();
        let completed_task = task_store.get_task(&task.id).await.unwrap();
        assert!(completed_task.completed_at.is_some());
        assert_eq!(completed_task.status, "completed");

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_update_worker_info() {
        let (task_store, database_path) = create_test_store().await;

        let task = task_store.create_task("task", "desc", 5).await.unwrap();

        task_store
            .update_worker_info(&task.id, 12345, "/tmp/worker-dir")
            .await
            .unwrap();

        let updated_task = task_store.get_task(&task.id).await.unwrap();
        assert_eq!(updated_task.worker_pid, Some(12345));
        assert_eq!(updated_task.worker_dir.as_deref(), Some("/tmp/worker-dir"));

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_update_result() {
        let (task_store, database_path) = create_test_store().await;

        let task = task_store.create_task("task", "desc", 5).await.unwrap();

        task_store
            .update_result(&task.id, 0, Some("all good"), None, Some(r#"["file.txt"]"#))
            .await
            .unwrap();

        let updated_task = task_store.get_task(&task.id).await.unwrap();
        assert_eq!(updated_task.exit_code, Some(0));
        assert_eq!(updated_task.output.as_deref(), Some("all good"));
        assert!(updated_task.error_message.is_none());
        assert_eq!(updated_task.artifacts.as_deref(), Some(r#"["file.txt"]"#));

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_add_token_usage_increments() {
        let (task_store, database_path) = create_test_store().await;

        let task = task_store.create_task("task", "desc", 5).await.unwrap();

        task_store
            .add_token_usage(&task.id, 100, 50, 0.005)
            .await
            .unwrap();
        task_store
            .add_token_usage(&task.id, 200, 100, 0.010)
            .await
            .unwrap();

        let updated_task = task_store.get_task(&task.id).await.unwrap();
        assert_eq!(updated_task.prompt_tokens, 300);
        assert_eq!(updated_task.completion_tokens, 150);
        assert!((updated_task.estimated_cost_usd - 0.015).abs() < 1e-9);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_write_and_get_task_logs() {
        let (task_store, database_path) = create_test_store().await;

        let task = task_store.create_task("task", "desc", 5).await.unwrap();

        task_store
            .write_log(&task.id, "info", "task started")
            .await
            .unwrap();
        task_store
            .write_log(&task.id, "error", "something went wrong")
            .await
            .unwrap();

        let logs = task_store.get_task_logs(&task.id).await;
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].0, "info");
        assert_eq!(logs[0].1, "task started");
        assert_eq!(logs[1].0, "error");
        assert_eq!(logs[1].1, "something went wrong");

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_count_by_status() {
        let (task_store, database_path) = create_test_store().await;

        task_store.create_task("t1", "d", 5).await.unwrap();
        task_store.create_task("t2", "d", 5).await.unwrap();

        let pending_count = task_store.count_by_status("pending").await;
        assert_eq!(pending_count, 2);

        let running_count = task_store.count_by_status("running").await;
        assert_eq!(running_count, 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_update_nonexistent_task_returns_error() {
        let (task_store, database_path) = create_test_store().await;

        let result = task_store
            .update_status("nonexistent-id", "running")
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no task found"));

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_get_daily_statistics_with_no_tasks() {
        let (task_store, database_path) = create_test_store().await;

        let daily_statistics = task_store.get_daily_statistics().await;

        assert_eq!(daily_statistics.completed_task_count, 0);
        assert_eq!(daily_statistics.failed_task_count, 0);
        assert!((daily_statistics.total_cost_usd - 0.0).abs() < 1e-9);
        assert_eq!(daily_statistics.total_prompt_tokens, 0);
        assert_eq!(daily_statistics.total_completion_tokens, 0);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_get_daily_statistics_counts_completed_and_failed_tasks() {
        let (task_store, database_path) = create_test_store().await;

        let completed_task = task_store
            .create_task("completed-task", "desc", 5)
            .await
            .unwrap();
        task_store
            .update_status(&completed_task.id, "running")
            .await
            .unwrap();
        task_store
            .update_status(&completed_task.id, "completed")
            .await
            .unwrap();

        let failed_task = task_store
            .create_task("failed-task", "desc", 5)
            .await
            .unwrap();
        task_store
            .update_status(&failed_task.id, "running")
            .await
            .unwrap();
        task_store
            .update_status(&failed_task.id, "failed")
            .await
            .unwrap();

        let pending_task = task_store
            .create_task("pending-task", "desc", 5)
            .await
            .unwrap();
        let _ = &pending_task;

        let daily_statistics = task_store.get_daily_statistics().await;

        assert_eq!(daily_statistics.completed_task_count, 1);
        assert_eq!(daily_statistics.failed_task_count, 1);

        let _ = std::fs::remove_file(&database_path);
    }

    #[tokio::test]
    async fn test_get_daily_statistics_aggregates_token_usage_and_cost() {
        let (task_store, database_path) = create_test_store().await;

        let first_task = task_store
            .create_task("first-task", "desc", 5)
            .await
            .unwrap();
        task_store
            .add_token_usage(&first_task.id, 100, 50, 0.005)
            .await
            .unwrap();

        let second_task = task_store
            .create_task("second-task", "desc", 5)
            .await
            .unwrap();
        task_store
            .add_token_usage(&second_task.id, 200, 100, 0.010)
            .await
            .unwrap();

        let daily_statistics = task_store.get_daily_statistics().await;

        assert_eq!(daily_statistics.total_prompt_tokens, 300);
        assert_eq!(daily_statistics.total_completion_tokens, 150);
        assert!((daily_statistics.total_cost_usd - 0.015).abs() < 1e-9);

        let _ = std::fs::remove_file(&database_path);
    }
}
