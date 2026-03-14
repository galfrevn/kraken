pub mod tasks;

use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::{Connection, Result as SqlResult};
use tracing::info;

/// A single-writer database pool protected by a tokio Mutex.
/// The daemon is the sole writer to SQLite; workers read via WAL concurrent reads.
pub type DatabasePool = Arc<Mutex<Connection>>;

/// Opens a SQLite connection at the given path, configures PRAGMAs for
/// WAL mode and foreign keys, runs migrations, and returns a shared pool.
pub fn open_database(path: &Path) -> SqlResult<DatabasePool> {
    let connection = Connection::open(path)?;

    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;"
    )?;

    info!(path = %path.display(), "opened SQLite database");

    run_migrations(&connection)?;

    Ok(Arc::new(Mutex::new(connection)))
}

/// Creates the schema tables and indexes if they do not already exist.
fn run_migrations(connection: &Connection) -> SqlResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS daemon_tasks (
            id                  TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            description         TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'pending',
            priority            INTEGER NOT NULL DEFAULT 5,
            trigger_id          TEXT,
            trigger_type        TEXT,
            trigger_payload     TEXT,
            worker_pid          INTEGER,
            worker_dir          TEXT,
            started_at          TEXT,
            completed_at        TEXT,
            updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
            timeout_ms          INTEGER NOT NULL DEFAULT 600000,
            exit_code           INTEGER,
            output              TEXT,
            error_message       TEXT,
            artifacts           TEXT,
            prompt_tokens       INTEGER NOT NULL DEFAULT 0,
            completion_tokens   INTEGER NOT NULL DEFAULT 0,
            estimated_cost_usd  REAL NOT NULL DEFAULT 0.0,
            attempt             INTEGER NOT NULL DEFAULT 1,
            max_retries         INTEGER NOT NULL DEFAULT 0,
            created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS task_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id     TEXT NOT NULL,
            level       TEXT NOT NULL,
            message     TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (task_id) REFERENCES daemon_tasks(id)
        );

        CREATE INDEX IF NOT EXISTS idx_daemon_tasks_status ON daemon_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);"
    )?;

    info!("database migrations completed");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_database_in_memory() {
        // Use a temporary file to verify open_database works end-to-end
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory.join("kraken_test_db_mod.sqlite");

        // Clean up any previous test file
        let _ = std::fs::remove_file(&database_path);

        let database_pool = open_database(&database_path).expect("should open database");

        // Verify we can acquire the lock (synchronous in test context)
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let connection = database_pool.lock().await;
            // Verify the tables exist by querying them
            let task_count: i64 = connection
                .query_row("SELECT COUNT(*) FROM daemon_tasks", [], |row| row.get(0))
                .expect("daemon_tasks table should exist");
            assert_eq!(task_count, 0);

            let log_count: i64 = connection
                .query_row("SELECT COUNT(*) FROM task_logs", [], |row| row.get(0))
                .expect("task_logs table should exist");
            assert_eq!(log_count, 0);
        });

        // Clean up
        let _ = std::fs::remove_file(&database_path);
    }
}
