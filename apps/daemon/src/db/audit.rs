use rusqlite::{Connection, Result as SqlResult, params};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub type AuditDatabasePool = Arc<Mutex<Connection>>;

pub fn open_audit_database(path: &Path) -> SqlResult<AuditDatabasePool> {
    let connection = Connection::open(path)?;

    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;",
    )?;

    info!(path = %path.display(), "opened audit SQLite database");

    run_audit_migrations(&connection)?;

    Ok(Arc::new(Mutex::new(connection)))
}

fn run_audit_migrations(connection: &Connection) -> SqlResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
            session_id      TEXT,
            task_id         TEXT,
            agent_id        TEXT,
            event_type      TEXT NOT NULL,
            tool            TEXT,
            action          TEXT,
            target          TEXT,
            input           TEXT,
            output          TEXT,
            success         INTEGER NOT NULL DEFAULT 1,
            error_message   TEXT,
            metadata        TEXT,
            duration_ms     INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_log_session_id ON audit_log(session_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
        CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target);",
    )?;

    info!("audit database migrations completed");
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuditEvent {
    #[serde(skip_deserializing)]
    pub id: Option<i64>,
    #[serde(default)]
    pub timestamp: Option<String>,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub agent_id: Option<String>,
    pub event_type: String,
    pub tool: Option<String>,
    pub action: Option<String>,
    pub target: Option<String>,
    pub input: Option<String>,
    pub output: Option<String>,
    #[serde(default = "default_success")]
    pub success: bool,
    pub error_message: Option<String>,
    pub metadata: Option<String>,
    pub duration_ms: Option<i64>,
}

fn default_success() -> bool {
    true
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct AuditQueryParams {
    pub session_id: Option<String>,
    pub event_type: Option<String>,
    pub target: Option<String>,
    pub since: Option<String>,
    pub limit: Option<i32>,
    pub offset: Option<i32>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditSummary {
    pub total_events: i64,
    pub tool_calls: i64,
    pub llm_calls: i64,
    pub file_operations: i64,
    pub command_executions: i64,
    pub errors: i64,
}

const DEFAULT_AUDIT_QUERY_LIMIT: i32 = 50;
const MAX_AUDIT_QUERY_LIMIT: i32 = 500;

#[derive(Clone)]
pub struct AuditStore {
    pool: AuditDatabasePool,
}

impl AuditStore {
    pub fn new(pool: AuditDatabasePool) -> Self {
        Self { pool }
    }

    pub async fn insert_event(&self, event: &AuditEvent) -> Result<i64, String> {
        let connection = self.pool.lock().await;

        connection
            .execute(
                "INSERT INTO audit_log (session_id, task_id, agent_id, event_type, tool, action, target, input, output, success, error_message, metadata, duration_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    event.session_id,
                    event.task_id,
                    event.agent_id,
                    event.event_type,
                    event.tool,
                    event.action,
                    event.target,
                    event.input,
                    event.output,
                    event.success as i32,
                    event.error_message,
                    event.metadata,
                    event.duration_ms,
                ],
            )
            .map_err(|error| format!("failed to insert audit event: {error}"))?;

        let inserted_id = connection.last_insert_rowid();
        Ok(inserted_id)
    }

    pub async fn query_events(&self, params: &AuditQueryParams) -> Vec<AuditEvent> {
        let connection = self.pool.lock().await;

        let limit = params
            .limit
            .unwrap_or(DEFAULT_AUDIT_QUERY_LIMIT)
            .clamp(1, MAX_AUDIT_QUERY_LIMIT);
        let offset = params.offset.unwrap_or(0).max(0);

        let mut conditions = Vec::new();
        let mut bind_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut param_index = 1;

        if let Some(ref session_id) = params.session_id {
            conditions.push(format!("session_id = ?{param_index}"));
            bind_values.push(Box::new(session_id.clone()));
            param_index += 1;
        }

        if let Some(ref event_type) = params.event_type {
            conditions.push(format!("event_type = ?{param_index}"));
            bind_values.push(Box::new(event_type.clone()));
            param_index += 1;
        }

        if let Some(ref target) = params.target {
            conditions.push(format!("target LIKE ?{param_index}"));
            bind_values.push(Box::new(format!("%{target}%")));
            param_index += 1;
        }

        if let Some(ref since) = params.since
            && let Some(threshold) = parse_relative_time(since)
        {
            conditions.push(format!("timestamp >= ?{param_index}"));
            bind_values.push(Box::new(threshold));
            param_index += 1;
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let query = format!(
            "SELECT id, timestamp, session_id, task_id, agent_id, event_type, tool, action, target, input, output, success, error_message, metadata, duration_ms
             FROM audit_log
             {where_clause}
             ORDER BY timestamp DESC
             LIMIT ?{param_index} OFFSET ?{}",
            param_index + 1
        );

        bind_values.push(Box::new(limit));
        bind_values.push(Box::new(offset));

        let bind_refs: Vec<&dyn rusqlite::types::ToSql> =
            bind_values.iter().map(|b| b.as_ref()).collect();

        connection
            .prepare(&query)
            .and_then(|mut stmt| {
                stmt.query_map(bind_refs.as_slice(), row_to_audit_event)
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_else(|error| {
                tracing::error!(error = %error, "audit query_events failed");
                Vec::new()
            })
    }

    pub async fn query_by_session(&self, session_id: &str) -> Vec<AuditEvent> {
        self.query_events(&AuditQueryParams {
            session_id: Some(session_id.to_string()),
            event_type: None,
            target: None,
            since: None,
            limit: Some(MAX_AUDIT_QUERY_LIMIT),
            offset: None,
        })
        .await
    }

    pub async fn summary(&self) -> AuditSummary {
        let connection = self.pool.lock().await;

        let total_events = connection
            .query_row("SELECT COUNT(*) FROM audit_log", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0);

        let tool_calls = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'tool_call'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);

        let llm_calls = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'llm_call'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);

        let file_operations = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type IN ('file_read', 'file_write', 'file_edit')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);

        let command_executions = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE event_type = 'command_execute'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);

        let errors = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE success = 0",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0);

        AuditSummary {
            total_events,
            tool_calls,
            llm_calls,
            file_operations,
            command_executions,
            errors,
        }
    }

    #[allow(dead_code)]
    pub async fn prune_old_events(&self, retention_days: u32) -> i32 {
        let connection = self.pool.lock().await;

        let delete_query = format!(
            "DELETE FROM audit_log WHERE timestamp < datetime('now', '-{retention_days} days')"
        );

        connection
            .execute(&delete_query, [])
            .unwrap_or_else(|error| {
                tracing::error!(error = %error, "prune_old_events failed");
                0
            }) as i32
    }
}

fn row_to_audit_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditEvent> {
    Ok(AuditEvent {
        id: Some(row.get("id")?),
        timestamp: row.get("timestamp")?,
        session_id: row.get("session_id")?,
        task_id: row.get("task_id")?,
        agent_id: row.get("agent_id")?,
        event_type: row.get("event_type")?,
        tool: row.get("tool")?,
        action: row.get("action")?,
        target: row.get("target")?,
        input: row.get("input")?,
        output: row.get("output")?,
        success: row.get::<_, i32>("success")? != 0,
        error_message: row.get("error_message")?,
        metadata: row.get("metadata")?,
        duration_ms: row.get("duration_ms")?,
    })
}

fn parse_relative_time(input: &str) -> Option<String> {
    let trimmed = input.trim();

    if trimmed.ends_with('h') {
        let hours: i64 = trimmed.trim_end_matches('h').parse().ok()?;
        return Some(format!("datetime('now', '-{hours} hours')"));
    }

    if trimmed.ends_with('d') {
        let days: i64 = trimmed.trim_end_matches('d').parse().ok()?;
        return Some(format!("datetime('now', '-{days} days')"));
    }

    if trimmed.ends_with('m') {
        let minutes: i64 = trimmed.trim_end_matches('m').parse().ok()?;
        return Some(format!("datetime('now', '-{minutes} minutes')"));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    async fn create_test_store() -> (AuditStore, PathBuf) {
        let temporary_directory = std::env::temp_dir();
        let database_path =
            temporary_directory.join(format!("kraken_test_audit_{}.sqlite", uuid::Uuid::new_v4()));
        let pool = open_audit_database(&database_path).expect("should open audit db");
        (AuditStore::new(pool), database_path)
    }

    #[tokio::test]
    async fn test_insert_and_query_event() {
        let (store, db_path) = create_test_store().await;

        let event = AuditEvent {
            id: None,
            timestamp: None,
            session_id: Some("sess-1".into()),
            task_id: None,
            agent_id: Some("build".into()),
            event_type: "tool_call".into(),
            tool: Some("bash".into()),
            action: Some("execute".into()),
            target: None,
            input: Some("ls -la".into()),
            output: Some("total 8".into()),
            success: true,
            error_message: None,
            metadata: None,
            duration_ms: Some(150),
        };

        let id = store.insert_event(&event).await.expect("should insert");
        assert!(id > 0);

        let results = store
            .query_events(&AuditQueryParams {
                session_id: Some("sess-1".into()),
                event_type: None,
                target: None,
                since: None,
                limit: None,
                offset: None,
            })
            .await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].tool.as_deref(), Some("bash"));

        let _ = std::fs::remove_file(&db_path);
    }

    #[tokio::test]
    async fn test_summary() {
        let (store, db_path) = create_test_store().await;

        for event_type in ["tool_call", "llm_call", "file_read", "command_execute"] {
            store
                .insert_event(&AuditEvent {
                    id: None,
                    timestamp: None,
                    session_id: None,
                    task_id: None,
                    agent_id: None,
                    event_type: event_type.into(),
                    tool: None,
                    action: None,
                    target: None,
                    input: None,
                    output: None,
                    success: true,
                    error_message: None,
                    metadata: None,
                    duration_ms: None,
                })
                .await
                .unwrap();
        }

        let summary = store.summary().await;
        assert_eq!(summary.total_events, 4);
        assert_eq!(summary.tool_calls, 1);
        assert_eq!(summary.llm_calls, 1);
        assert_eq!(summary.file_operations, 1);
        assert_eq!(summary.command_executions, 1);

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn test_parse_relative_time() {
        assert!(parse_relative_time("24h").is_some());
        assert!(parse_relative_time("7d").is_some());
        assert!(parse_relative_time("30m").is_some());
        assert!(parse_relative_time("invalid").is_none());
    }
}
