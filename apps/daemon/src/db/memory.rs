use rusqlite::{Connection, Result as SqlResult, Row, params};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use super::DatabasePool;

const DEDUP_WINDOW_MINUTES: i64 = 30;
const DEFAULT_CONTEXT_SESSION_LIMIT: i64 = 5;
const DEFAULT_CONTEXT_OBSERVATION_LIMIT: i64 = 20;
const DEFAULT_SEARCH_LIMIT: i64 = 10;
const DEFAULT_TIMELINE_RANGE: i64 = 5;
const RRF_K: f64 = 60.0;
const EMBEDDING_DIMENSIONS: usize = 1536;
const AGING_MAX_SESSION_SUMMARIES_PER_PROJECT: i64 = 5;
const PRUNING_SOFT_DELETE_RETENTION_DAYS: i64 = 30;

#[derive(Debug, Clone, serde::Serialize)]
pub struct MemorySession {
    pub id: String,
    pub project: String,
    pub directory: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub summary: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Observation {
    pub id: i64,
    pub session_id: String,
    pub observation_type: String,
    pub title: String,
    pub content: String,
    pub project: Option<String>,
    pub scope: String,
    pub topic_key: Option<String>,
    pub revision_count: i32,
    pub duplicate_count: i32,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    #[serde(flatten)]
    pub observation: Observation,
    pub rank: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TimelineEntry {
    #[serde(flatten)]
    pub observation: Observation,
    pub is_focus: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TimelineResult {
    pub focus: Observation,
    pub before: Vec<TimelineEntry>,
    pub after: Vec<TimelineEntry>,
    pub session_info: Option<MemorySession>,
    pub total_in_range: i32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextResponse {
    pub sessions: Vec<MemorySession>,
    pub observations: Vec<Observation>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryStats {
    pub total_sessions: i64,
    pub total_observations: i64,
    pub projects: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SaveObservationParams {
    pub session_id: String,
    pub observation_type: String,
    pub title: String,
    pub content: String,
    pub project: Option<String>,
    pub scope: Option<String>,
    pub topic_key: Option<String>,
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct UpdateObservationParams {
    pub observation_type: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub project: Option<String>,
    pub scope: Option<String>,
    pub topic_key: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SearchOptions {
    pub query: String,
    pub observation_type: Option<String>,
    pub project: Option<String>,
    pub scope: Option<String>,
    pub limit: Option<i64>,
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PruneResult {
    pub pruned_observations: i64,
    pub pruned_vec_entries: i64,
}

pub struct MemoryStore {
    pool: DatabasePool,
}

pub fn open_memory_database(path: &Path) -> SqlResult<DatabasePool> {
    let connection = Connection::open(path)?;

    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA cache_size = -64000;
         PRAGMA foreign_keys = ON;",
    )?;

    unsafe {
        sqlite_vec::sqlite3_vec_init();
    }
    info!("sqlite-vec extension loaded");

    info!(path = %path.display(), "opened memory SQLite database");

    run_memory_migrations(&connection)?;

    Ok(Arc::new(Mutex::new(connection)))
}

fn run_memory_migrations(connection: &Connection) -> SqlResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_sessions (
            id          TEXT PRIMARY KEY,
            project     TEXT NOT NULL,
            directory   TEXT NOT NULL DEFAULT '',
            started_at  TEXT NOT NULL DEFAULT (datetime('now')),
            ended_at    TEXT,
            summary     TEXT,
            status      TEXT NOT NULL DEFAULT 'active'
        );

        CREATE TABLE IF NOT EXISTS memory_observations (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id       TEXT NOT NULL,
            type             TEXT NOT NULL,
            title            TEXT NOT NULL,
            content          TEXT NOT NULL,
            project          TEXT,
            scope            TEXT NOT NULL DEFAULT 'project',
            topic_key        TEXT,
            normalized_hash  TEXT,
            revision_count   INTEGER NOT NULL DEFAULT 1,
            duplicate_count  INTEGER NOT NULL DEFAULT 0,
            last_seen_at     TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
            deleted_at       TEXT,
            FOREIGN KEY (session_id) REFERENCES memory_sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_observations_session
            ON memory_observations(session_id);
        CREATE INDEX IF NOT EXISTS idx_observations_project
            ON memory_observations(project);
        CREATE INDEX IF NOT EXISTS idx_observations_topic_key
            ON memory_observations(topic_key);
        CREATE INDEX IF NOT EXISTS idx_observations_hash
            ON memory_observations(normalized_hash);
        CREATE INDEX IF NOT EXISTS idx_observations_deleted
            ON memory_observations(deleted_at);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_fts
            USING fts5(title, content, type, project, content='memory_observations', content_rowid='id');

        CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON memory_observations BEGIN
            INSERT INTO memory_observations_fts(rowid, title, content, type, project)
            VALUES (new.id, new.title, new.content, new.type, COALESCE(new.project, ''));
        END;

        CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON memory_observations BEGIN
            INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content, type, project)
            VALUES ('delete', old.id, old.title, old.content, old.type, COALESCE(old.project, ''));
        END;

        CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON memory_observations BEGIN
            INSERT INTO memory_observations_fts(memory_observations_fts, rowid, title, content, type, project)
            VALUES ('delete', old.id, old.title, old.content, old.type, COALESCE(old.project, ''));
            INSERT INTO memory_observations_fts(rowid, title, content, type, project)
            VALUES (new.id, new.title, new.content, new.type, COALESCE(new.project, ''));
        END;",
    )?;

    let embedding_column_result =
        connection.execute_batch("ALTER TABLE memory_observations ADD COLUMN embedding BLOB;");
    match embedding_column_result {
        Ok(_) => {}
        Err(ref error) if error.to_string().contains("duplicate column") => {}
        Err(unexpected) => return Err(unexpected),
    }

    let vec_table_result = connection.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_observations_vec USING vec0(
            observation_id INTEGER PRIMARY KEY,
            embedding float[{EMBEDDING_DIMENSIONS}]
        );"
    ));
    match vec_table_result {
        Ok(_) => {}
        Err(ref error) if error.to_string().contains("already exists") => {}
        Err(unexpected) => {
            warn!(error = %unexpected, "failed to create vec0 table, vector search disabled");
        }
    }

    info!("memory database migrations completed");
    Ok(())
}

fn row_to_observation(row: &Row<'_>) -> SqlResult<Observation> {
    Ok(Observation {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        observation_type: row.get("type")?,
        title: row.get("title")?,
        content: row.get("content")?,
        project: row.get("project")?,
        scope: row.get("scope")?,
        topic_key: row.get("topic_key")?,
        revision_count: row.get("revision_count")?,
        duplicate_count: row.get("duplicate_count")?,
        last_seen_at: row.get("last_seen_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
    })
}

fn row_to_session(row: &Row<'_>) -> SqlResult<MemorySession> {
    Ok(MemorySession {
        id: row.get("id")?,
        project: row.get("project")?,
        directory: row.get("directory")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        summary: row.get("summary")?,
        status: row.get("status")?,
    })
}

fn compute_normalized_hash(
    content: &str,
    project: &str,
    scope: &str,
    observation_type: &str,
    title: &str,
) -> String {
    let normalized = format!(
        "{}:{}:{}:{}:{}",
        project.trim().to_lowercase(),
        scope.trim().to_lowercase(),
        observation_type.trim().to_lowercase(),
        title.trim().to_lowercase(),
        content.trim().to_lowercase(),
    );
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

fn sanitize_fts_query(raw_query: &str) -> String {
    raw_query
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .map(|word| {
            let cleaned: String = word
                .chars()
                .filter(|character| {
                    character.is_alphanumeric() || *character == '_' || *character == '-'
                })
                .collect();
            if cleaned.is_empty() {
                String::new()
            } else {
                format!("\"{cleaned}\"")
            }
        })
        .filter(|quoted| !quoted.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn embedding_to_blob(embedding: &[f32]) -> Vec<u8> {
    embedding
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

#[allow(dead_code)]
fn blob_to_embedding(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

impl MemoryStore {
    pub fn new(pool: DatabasePool) -> Self {
        Self { pool }
    }

    pub async fn start_session(
        &self,
        session_id: &str,
        project: &str,
        directory: &str,
    ) -> SqlResult<MemorySession> {
        let connection = self.pool.lock().await;

        connection.execute(
            "INSERT INTO memory_sessions (id, project, directory)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                project = excluded.project,
                directory = excluded.directory",
            params![session_id, project, directory],
        )?;

        let session = connection.query_row(
            "SELECT id, project, directory, started_at, ended_at, summary, status
             FROM memory_sessions WHERE id = ?1",
            params![session_id],
            row_to_session,
        )?;

        Ok(session)
    }

    pub async fn end_session(&self, session_id: &str, summary: Option<&str>) -> SqlResult<()> {
        let connection = self.pool.lock().await;

        connection.execute(
            "UPDATE memory_sessions
             SET ended_at = datetime('now'), status = 'completed', summary = COALESCE(?2, summary)
             WHERE id = ?1",
            params![session_id, summary],
        )?;

        Ok(())
    }

    pub async fn get_session(&self, session_id: &str) -> SqlResult<MemorySession> {
        let connection = self.pool.lock().await;

        connection.query_row(
            "SELECT id, project, directory, started_at, ended_at, summary, status
             FROM memory_sessions WHERE id = ?1",
            params![session_id],
            row_to_session,
        )
    }

    pub async fn save_observation(&self, params: SaveObservationParams) -> SqlResult<Observation> {
        let connection = self.pool.lock().await;

        let scope = params.scope.as_deref().unwrap_or("project");
        let project = params.project.as_deref().unwrap_or("");

        let normalized_hash = compute_normalized_hash(
            &params.content,
            project,
            scope,
            &params.observation_type,
            &params.title,
        );

        if let Some(ref topic_key) = params.topic_key {
            let existing_observation_id: Option<i64> = connection
                .query_row(
                    "SELECT id FROM memory_observations
                     WHERE project = ?1 AND scope = ?2 AND topic_key = ?3 AND deleted_at IS NULL
                     ORDER BY created_at DESC LIMIT 1",
                    params![project, scope, topic_key],
                    |row| row.get(0),
                )
                .ok();

            if let Some(existing_id) = existing_observation_id {
                let embedding_blob = params.embedding.as_deref().map(embedding_to_blob);
                connection.execute(
                    "UPDATE memory_observations SET
                        title = ?2, content = ?3, type = ?4, normalized_hash = ?5,
                        revision_count = revision_count + 1,
                        updated_at = datetime('now'),
                        embedding = COALESCE(?6, embedding)
                     WHERE id = ?1",
                    params![
                        existing_id,
                        params.title,
                        params.content,
                        params.observation_type,
                        normalized_hash,
                        embedding_blob
                    ],
                )?;

                if let Some(ref emb) = embedding_blob {
                    let _ = connection.execute(
                        "INSERT OR REPLACE INTO memory_observations_vec(observation_id, embedding)
                         VALUES (?1, ?2)",
                        params![existing_id, emb],
                    );
                }

                let updated_observation = connection.query_row(
                    "SELECT id, session_id, type, title, content, project, scope, topic_key,
                            revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
                     FROM memory_observations WHERE id = ?1",
                    params![existing_id],
                    row_to_observation,
                )?;

                return Ok(updated_observation);
            }
        }

        let duplicate_id: Option<i64> = connection
            .query_row(
                "SELECT id FROM memory_observations
                 WHERE normalized_hash = ?1 AND deleted_at IS NULL
                   AND created_at > datetime('now', ?2)
                 ORDER BY created_at DESC LIMIT 1",
                params![normalized_hash, format!("-{DEDUP_WINDOW_MINUTES} minutes")],
                |row| row.get(0),
            )
            .ok();

        if let Some(dup_id) = duplicate_id {
            connection.execute(
                "UPDATE memory_observations SET
                    duplicate_count = duplicate_count + 1,
                    last_seen_at = datetime('now'),
                    updated_at = datetime('now')
                 WHERE id = ?1",
                params![dup_id],
            )?;

            let duplicate_observation = connection.query_row(
                "SELECT id, session_id, type, title, content, project, scope, topic_key,
                        revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
                 FROM memory_observations WHERE id = ?1",
                params![dup_id],
                row_to_observation,
            )?;

            return Ok(duplicate_observation);
        }

        let embedding_blob = params.embedding.as_deref().map(embedding_to_blob);
        connection.execute(
            "INSERT INTO memory_observations
                (session_id, type, title, content, project, scope, topic_key, normalized_hash, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                params.session_id,
                params.observation_type,
                params.title,
                params.content,
                project,
                scope,
                params.topic_key,
                normalized_hash,
                embedding_blob
            ],
        )?;

        let inserted_id = connection.last_insert_rowid();

        if let Some(ref emb) = embedding_blob {
            let _ = connection.execute(
                "INSERT INTO memory_observations_vec(observation_id, embedding)
                 VALUES (?1, ?2)",
                params![inserted_id, emb],
            );
        }

        run_aging(&connection, project, &params.observation_type);

        let inserted_observation = connection.query_row(
            "SELECT id, session_id, type, title, content, project, scope, topic_key,
                    revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
             FROM memory_observations WHERE id = ?1",
            params![inserted_id],
            row_to_observation,
        )?;

        Ok(inserted_observation)
    }

    pub async fn get_observation(&self, observation_id: i64) -> SqlResult<Observation> {
        let connection = self.pool.lock().await;

        connection.query_row(
            "SELECT id, session_id, type, title, content, project, scope, topic_key,
                    revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
             FROM memory_observations WHERE id = ?1 AND deleted_at IS NULL",
            params![observation_id],
            row_to_observation,
        )
    }

    pub async fn update_observation(
        &self,
        observation_id: i64,
        params: UpdateObservationParams,
    ) -> SqlResult<Observation> {
        let connection = self.pool.lock().await;

        let mut set_clauses: Vec<String> = vec!["updated_at = datetime('now')".to_string()];
        let mut bound_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut param_index = 1;

        macro_rules! maybe_set {
            ($field:expr, $column:expr) => {
                if let Some(ref value) = $field {
                    param_index += 1;
                    set_clauses.push(format!("{} = ?{}", $column, param_index));
                    bound_values.push(Box::new(value.clone()));
                }
            };
        }

        maybe_set!(params.observation_type, "type");
        maybe_set!(params.title, "title");
        maybe_set!(params.content, "content");
        maybe_set!(params.project, "project");
        maybe_set!(params.scope, "scope");
        maybe_set!(params.topic_key, "topic_key");

        let sql = format!(
            "UPDATE memory_observations SET {} WHERE id = ?1 AND deleted_at IS NULL",
            set_clauses.join(", ")
        );

        let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(observation_id)];
        all_params.extend(bound_values);

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            all_params.iter().map(|boxed| boxed.as_ref()).collect();

        connection.execute(&sql, param_refs.as_slice())?;

        connection.query_row(
            "SELECT id, session_id, type, title, content, project, scope, topic_key,
                    revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
             FROM memory_observations WHERE id = ?1",
            params![observation_id],
            row_to_observation,
        )
    }

    pub async fn delete_observation(
        &self,
        observation_id: i64,
        hard_delete: bool,
    ) -> SqlResult<()> {
        let connection = self.pool.lock().await;

        if hard_delete {
            connection.execute(
                "DELETE FROM memory_observations WHERE id = ?1",
                params![observation_id],
            )?;
        } else {
            connection.execute(
                "UPDATE memory_observations SET deleted_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![observation_id],
            )?;
        }

        Ok(())
    }

    #[allow(dead_code)]
    pub async fn search(&self, options: SearchOptions) -> SqlResult<Vec<SearchResult>> {
        let connection = self.pool.lock().await;

        let sanitized_query = sanitize_fts_query(&options.query);
        if sanitized_query.is_empty() {
            return Ok(Vec::new());
        }

        let limit = options.limit.unwrap_or(DEFAULT_SEARCH_LIMIT);

        let mut where_clauses = vec![
            "memory_observations_fts MATCH ?1".to_string(),
            "observations.deleted_at IS NULL".to_string(),
        ];
        let mut bound_values: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(sanitized_query)];
        let mut param_index = 1;

        if let Some(ref observation_type) = options.observation_type {
            param_index += 1;
            where_clauses.push(format!("observations.type = ?{param_index}"));
            bound_values.push(Box::new(observation_type.clone()));
        }
        if let Some(ref project) = options.project {
            param_index += 1;
            let project_param_idx = param_index;
            where_clauses.push(format!(
                "(observations.project = ?{project_param_idx} OR observations.scope = 'personal')"
            ));
            bound_values.push(Box::new(project.clone()));
        }
        if let Some(ref scope) = options.scope {
            param_index += 1;
            where_clauses.push(format!("observations.scope = ?{param_index}"));
            bound_values.push(Box::new(scope.clone()));
        }

        param_index += 1;
        bound_values.push(Box::new(limit));

        let sql = format!(
            "SELECT observations.id, observations.session_id, observations.type,
                    observations.title, observations.content, observations.project,
                    observations.scope, observations.topic_key, observations.revision_count,
                    observations.duplicate_count, observations.last_seen_at,
                    observations.created_at, observations.updated_at, observations.deleted_at,
                    rank
             FROM memory_observations_fts
             JOIN memory_observations observations ON observations.id = memory_observations_fts.rowid
             WHERE {}
             ORDER BY rank
             LIMIT ?{param_index}",
            where_clauses.join(" AND ")
        );

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            bound_values.iter().map(|boxed| boxed.as_ref()).collect();

        let mut statement = connection.prepare(&sql)?;
        let results = statement
            .query_map(param_refs.as_slice(), |row| {
                let observation = row_to_observation(row)?;
                let rank: f64 = row.get("rank")?;
                Ok(SearchResult { observation, rank })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(results)
    }

    pub async fn get_context(
        &self,
        project: Option<&str>,
        session_limit: Option<i64>,
        observation_limit: Option<i64>,
    ) -> SqlResult<ContextResponse> {
        let connection = self.pool.lock().await;

        let session_limit = session_limit.unwrap_or(DEFAULT_CONTEXT_SESSION_LIMIT);
        let observation_limit = observation_limit.unwrap_or(DEFAULT_CONTEXT_OBSERVATION_LIMIT);

        let sessions = if let Some(project_name) = project {
            let mut statement = connection.prepare(
                "SELECT id, project, directory, started_at, ended_at, summary, status
                 FROM memory_sessions
                 WHERE project = ?1 AND status = 'completed' AND summary IS NOT NULL
                 ORDER BY ended_at DESC LIMIT ?2",
            )?;
            statement
                .query_map(params![project_name, session_limit], row_to_session)?
                .collect::<SqlResult<Vec<_>>>()?
        } else {
            let mut statement = connection.prepare(
                "SELECT id, project, directory, started_at, ended_at, summary, status
                 FROM memory_sessions
                 WHERE status = 'completed' AND summary IS NOT NULL
                 ORDER BY ended_at DESC LIMIT ?1",
            )?;
            statement
                .query_map(params![session_limit], row_to_session)?
                .collect::<SqlResult<Vec<_>>>()?
        };

        let observations = if let Some(project_name) = project {
            let mut statement = connection.prepare(
                "SELECT id, session_id, type, title, content, project, scope, topic_key,
                        revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
                 FROM memory_observations
                 WHERE (project = ?1 OR scope = 'personal') AND deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT ?2",
            )?;
            statement
                .query_map(params![project_name, observation_limit], row_to_observation)?
                .collect::<SqlResult<Vec<_>>>()?
        } else {
            let mut statement = connection.prepare(
                "SELECT id, session_id, type, title, content, project, scope, topic_key,
                        revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
                 FROM memory_observations
                 WHERE deleted_at IS NULL
                 ORDER BY updated_at DESC LIMIT ?1",
            )?;
            statement
                .query_map(params![observation_limit], row_to_observation)?
                .collect::<SqlResult<Vec<_>>>()?
        };

        Ok(ContextResponse {
            sessions,
            observations,
        })
    }

    pub async fn get_timeline(
        &self,
        observation_id: i64,
        before: Option<i64>,
        after: Option<i64>,
    ) -> SqlResult<TimelineResult> {
        let connection = self.pool.lock().await;

        let focus = connection.query_row(
            "SELECT id, session_id, type, title, content, project, scope, topic_key,
                    revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
             FROM memory_observations WHERE id = ?1 AND deleted_at IS NULL",
            params![observation_id],
            row_to_observation,
        )?;

        let before_limit = before.unwrap_or(DEFAULT_TIMELINE_RANGE);
        let after_limit = after.unwrap_or(DEFAULT_TIMELINE_RANGE);

        let mut before_statement = connection.prepare(
            "SELECT id, session_id, type, title, content, project, scope, topic_key,
                    revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
             FROM memory_observations
             WHERE session_id = ?1 AND id < ?2 AND deleted_at IS NULL
             ORDER BY id DESC LIMIT ?3",
        )?;
        let mut before_entries: Vec<TimelineEntry> = before_statement
            .query_map(
                params![focus.session_id, observation_id, before_limit],
                |row| {
                    let observation = row_to_observation(row)?;
                    Ok(TimelineEntry {
                        observation,
                        is_focus: false,
                    })
                },
            )?
            .collect::<SqlResult<Vec<_>>>()?;
        before_entries.reverse();

        let mut after_statement = connection.prepare(
            "SELECT id, session_id, type, title, content, project, scope, topic_key,
                    revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
             FROM memory_observations
             WHERE session_id = ?1 AND id > ?2 AND deleted_at IS NULL
             ORDER BY id ASC LIMIT ?3",
        )?;
        let after_entries: Vec<TimelineEntry> = after_statement
            .query_map(
                params![focus.session_id, observation_id, after_limit],
                |row| {
                    let observation = row_to_observation(row)?;
                    Ok(TimelineEntry {
                        observation,
                        is_focus: false,
                    })
                },
            )?
            .collect::<SqlResult<Vec<_>>>()?;

        let session_info = connection
            .query_row(
                "SELECT id, project, directory, started_at, ended_at, summary, status
                 FROM memory_sessions WHERE id = ?1",
                params![focus.session_id],
                row_to_session,
            )
            .ok();

        let total_in_range = (before_entries.len() + after_entries.len() + 1) as i32;

        Ok(TimelineResult {
            focus,
            before: before_entries,
            after: after_entries,
            session_info,
            total_in_range,
        })
    }

    pub async fn get_stats(&self) -> SqlResult<MemoryStats> {
        let connection = self.pool.lock().await;

        let total_sessions: i64 =
            connection.query_row("SELECT COUNT(*) FROM memory_sessions", [], |row| row.get(0))?;

        let total_observations: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memory_observations WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )?;

        let mut project_statement = connection.prepare(
            "SELECT DISTINCT project FROM memory_observations
             WHERE project IS NOT NULL AND project != '' AND deleted_at IS NULL
             ORDER BY project",
        )?;
        let projects: Vec<String> = project_statement
            .query_map([], |row| row.get(0))?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(MemoryStats {
            total_sessions,
            total_observations,
            projects,
        })
    }

    pub async fn hybrid_search(&self, options: SearchOptions) -> SqlResult<Vec<SearchResult>> {
        let connection = self.pool.lock().await;
        let limit = options.limit.unwrap_or(DEFAULT_SEARCH_LIMIT);

        let mut fts_ranked: Vec<(i64, f64)> = Vec::new();
        let sanitized_query = sanitize_fts_query(&options.query);

        if !sanitized_query.is_empty() {
            let mut fts_where = vec![
                "memory_observations_fts MATCH ?1".to_string(),
                "obs.deleted_at IS NULL".to_string(),
            ];
            let mut fts_params: Vec<Box<dyn rusqlite::types::ToSql>> =
                vec![Box::new(sanitized_query)];
            let mut fts_idx = 1;

            if let Some(ref observation_type) = options.observation_type {
                fts_idx += 1;
                fts_where.push(format!("obs.type = ?{fts_idx}"));
                fts_params.push(Box::new(observation_type.clone()));
            }
            if let Some(ref project) = options.project {
                fts_idx += 1;
                let project_param_idx = fts_idx;
                fts_where.push(format!(
                    "(obs.project = ?{project_param_idx} OR obs.scope = 'personal')"
                ));
                fts_params.push(Box::new(project.clone()));
            }
            if let Some(ref scope) = options.scope {
                fts_idx += 1;
                fts_where.push(format!("obs.scope = ?{fts_idx}"));
                fts_params.push(Box::new(scope.clone()));
            }

            fts_idx += 1;
            fts_params.push(Box::new(limit * 3));

            let fts_sql = format!(
                "SELECT obs.id, rank
                 FROM memory_observations_fts
                 JOIN memory_observations obs ON obs.id = memory_observations_fts.rowid
                 WHERE {}
                 ORDER BY rank
                 LIMIT ?{fts_idx}",
                fts_where.join(" AND ")
            );

            let fts_refs: Vec<&dyn rusqlite::types::ToSql> =
                fts_params.iter().map(|b| b.as_ref()).collect();

            let mut fts_stmt = connection.prepare(&fts_sql)?;
            fts_ranked = fts_stmt
                .query_map(fts_refs.as_slice(), |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
                })?
                .collect::<SqlResult<Vec<_>>>()?;
        }

        let mut vec_ranked: Vec<(i64, f64)> = Vec::new();

        if let Some(ref query_embedding) = options.embedding {
            let query_blob = embedding_to_blob(query_embedding);
            let vec_limit = limit * 3;

            let vec_sql = "SELECT observation_id, distance
                 FROM memory_observations_vec
                 WHERE embedding MATCH ?1
                 ORDER BY distance
                 LIMIT ?2";

            let mut vec_stmt = match connection.prepare(vec_sql) {
                Ok(statement) => statement,
                Err(_) => {
                    if fts_ranked.is_empty() {
                        return Ok(Vec::new());
                    }
                    return self.fetch_observations_by_ids(&connection, &fts_ranked, limit);
                }
            };

            vec_ranked = vec_stmt
                .query_map(params![query_blob, vec_limit], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
                })?
                .collect::<SqlResult<Vec<_>>>()?;
        }

        if fts_ranked.is_empty() && vec_ranked.is_empty() {
            return Ok(Vec::new());
        }

        if vec_ranked.is_empty() {
            return self.fetch_observations_by_ids(&connection, &fts_ranked, limit);
        }

        if fts_ranked.is_empty() {
            return self.fetch_observations_by_ids(&connection, &vec_ranked, limit);
        }

        let mut rrf_scores: HashMap<i64, f64> = HashMap::new();

        for (rank_position, (observation_id, _)) in fts_ranked.iter().enumerate() {
            *rrf_scores.entry(*observation_id).or_default() +=
                1.0 / (RRF_K + rank_position as f64 + 1.0);
        }
        for (rank_position, (observation_id, _)) in vec_ranked.iter().enumerate() {
            *rrf_scores.entry(*observation_id).or_default() +=
                1.0 / (RRF_K + rank_position as f64 + 1.0);
        }

        let mut sorted_ids: Vec<(i64, f64)> = rrf_scores.into_iter().collect();
        sorted_ids.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        sorted_ids.truncate(limit as usize);

        self.fetch_observations_by_ids(&connection, &sorted_ids, limit)
    }

    fn fetch_observations_by_ids(
        &self,
        connection: &Connection,
        ranked_ids: &[(i64, f64)],
        limit: i64,
    ) -> SqlResult<Vec<SearchResult>> {
        let ids: Vec<i64> = ranked_ids
            .iter()
            .take(limit as usize)
            .map(|(id, _)| *id)
            .collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders: String = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id, session_id, type, title, content, project, scope, topic_key,
                    revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at
             FROM memory_observations
             WHERE id IN ({placeholders}) AND deleted_at IS NULL"
        );

        let param_values: Vec<Box<dyn rusqlite::types::ToSql>> = ids
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
            .collect();
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|b| b.as_ref()).collect();

        let mut statement = connection.prepare(&sql)?;
        let observations: HashMap<i64, Observation> = statement
            .query_map(param_refs.as_slice(), row_to_observation)?
            .filter_map(|result| result.ok())
            .map(|obs| (obs.id, obs))
            .collect();

        let rank_map: HashMap<i64, f64> = ranked_ids.iter().copied().collect();

        let mut results: Vec<SearchResult> = ids
            .iter()
            .filter_map(|id| {
                observations.get(id).map(|obs| SearchResult {
                    observation: obs.clone(),
                    rank: *rank_map.get(id).unwrap_or(&0.0),
                })
            })
            .collect();

        results.sort_by(|a, b| {
            rank_map
                .get(&b.observation.id)
                .unwrap_or(&0.0)
                .partial_cmp(rank_map.get(&a.observation.id).unwrap_or(&0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(results)
    }

    pub async fn prune(&self) -> SqlResult<PruneResult> {
        let connection = self.pool.lock().await;

        let pruned_observations: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memory_observations
             WHERE deleted_at IS NOT NULL
               AND deleted_at < datetime('now', ?1)",
            params![format!("-{PRUNING_SOFT_DELETE_RETENTION_DAYS} days")],
            |row| row.get(0),
        )?;

        connection.execute(
            "DELETE FROM memory_observations
             WHERE deleted_at IS NOT NULL
               AND deleted_at < datetime('now', ?1)",
            params![format!("-{PRUNING_SOFT_DELETE_RETENTION_DAYS} days")],
        )?;

        let pruned_vec_entries: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memory_observations_vec
                 WHERE observation_id NOT IN (SELECT id FROM memory_observations)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let _ = connection.execute(
            "DELETE FROM memory_observations_vec
             WHERE observation_id NOT IN (SELECT id FROM memory_observations)",
            [],
        );

        Ok(PruneResult {
            pruned_observations,
            pruned_vec_entries,
        })
    }
}

fn run_aging(connection: &Connection, project: &str, observation_type: &str) {
    if observation_type == "progress" {
        let _ = connection.execute(
            "UPDATE memory_observations SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE project = ?1 AND type = 'progress' AND deleted_at IS NULL
               AND id NOT IN (
                   SELECT id FROM memory_observations
                   WHERE project = ?1 AND type = 'progress' AND deleted_at IS NULL
                   ORDER BY created_at DESC LIMIT 1
               )",
            params![project],
        );
    }

    if observation_type == "session-summary" {
        let _ = connection.execute(
            "UPDATE memory_observations SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE project = ?1 AND type = 'session-summary' AND deleted_at IS NULL
               AND id NOT IN (
                   SELECT id FROM memory_observations
                   WHERE project = ?1 AND type = 'session-summary' AND deleted_at IS NULL
                   ORDER BY created_at DESC LIMIT ?2
               )",
            params![project, AGING_MAX_SESSION_SUMMARIES_PER_PROJECT],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn create_test_memory_store() -> MemoryStore {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory.join(format!(
            "kraken_test_memory_{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let pool = open_memory_database(&database_path).expect("should open memory database");
        MemoryStore::new(pool)
    }

    #[tokio::test]
    async fn test_session_lifecycle() {
        let store = create_test_memory_store().await;

        let session = store
            .start_session("test-session-1", "kraken", "/home/user/kraken")
            .await
            .expect("should start session");
        assert_eq!(session.status, "active");
        assert_eq!(session.project, "kraken");

        store
            .end_session("test-session-1", Some("Worked on memory system"))
            .await
            .expect("should end session");

        let ended_session = store
            .get_session("test-session-1")
            .await
            .expect("should get session");
        assert_eq!(ended_session.status, "completed");
        assert_eq!(
            ended_session.summary.as_deref(),
            Some("Worked on memory system")
        );
    }

    #[tokio::test]
    async fn test_save_and_search_observation() {
        let store = create_test_memory_store().await;

        store
            .start_session("sess-1", "kraken", "/home/user/kraken")
            .await
            .unwrap();

        let observation = store
            .save_observation(SaveObservationParams {
                session_id: "sess-1".to_string(),
                observation_type: "architecture".to_string(),
                title: "Chose SQLite for memory storage".to_string(),
                content:
                    "**What**: Using SQLite with FTS5\n**Why**: Simple, fast, no external deps"
                        .to_string(),
                project: Some("kraken".to_string()),
                scope: None,
                topic_key: None,
                embedding: None,
            })
            .await
            .expect("should save observation");

        assert_eq!(observation.title, "Chose SQLite for memory storage");
        assert_eq!(observation.revision_count, 1);

        let results = store
            .search(SearchOptions {
                query: "SQLite memory".to_string(),
                observation_type: None,
                project: None,
                scope: None,
                limit: None,
                embedding: None,
            })
            .await
            .expect("should search");

        assert!(!results.is_empty());
        assert_eq!(
            results[0].observation.title,
            "Chose SQLite for memory storage"
        );
    }

    #[tokio::test]
    async fn test_topic_key_upsert() {
        let store = create_test_memory_store().await;

        store
            .start_session("sess-1", "kraken", "/home/user/kraken")
            .await
            .unwrap();

        let first_save = store
            .save_observation(SaveObservationParams {
                session_id: "sess-1".to_string(),
                observation_type: "architecture".to_string(),
                title: "Auth approach v1".to_string(),
                content: "Using JWT".to_string(),
                project: Some("kraken".to_string()),
                scope: None,
                topic_key: Some("architecture/auth".to_string()),
                embedding: None,
            })
            .await
            .unwrap();

        assert_eq!(first_save.revision_count, 1);

        let second_save = store
            .save_observation(SaveObservationParams {
                session_id: "sess-1".to_string(),
                observation_type: "architecture".to_string(),
                title: "Auth approach v2".to_string(),
                content: "Switched to session tokens".to_string(),
                project: Some("kraken".to_string()),
                scope: None,
                topic_key: Some("architecture/auth".to_string()),
                embedding: None,
            })
            .await
            .unwrap();

        assert_eq!(second_save.id, first_save.id);
        assert_eq!(second_save.revision_count, 2);
        assert_eq!(second_save.title, "Auth approach v2");
    }

    #[tokio::test]
    async fn test_dedup_within_window() {
        let store = create_test_memory_store().await;

        store
            .start_session("sess-1", "kraken", "/home/user/kraken")
            .await
            .unwrap();

        let first = store
            .save_observation(SaveObservationParams {
                session_id: "sess-1".to_string(),
                observation_type: "bugfix".to_string(),
                title: "Fixed null pointer".to_string(),
                content: "Check for null before deref".to_string(),
                project: Some("kraken".to_string()),
                scope: None,
                topic_key: None,
                embedding: None,
            })
            .await
            .unwrap();

        let duplicate = store
            .save_observation(SaveObservationParams {
                session_id: "sess-1".to_string(),
                observation_type: "bugfix".to_string(),
                title: "Fixed null pointer".to_string(),
                content: "Check for null before deref".to_string(),
                project: Some("kraken".to_string()),
                scope: None,
                topic_key: None,
                embedding: None,
            })
            .await
            .unwrap();

        assert_eq!(duplicate.id, first.id);
        assert_eq!(duplicate.duplicate_count, 1);
    }

    #[tokio::test]
    async fn test_soft_delete() {
        let store = create_test_memory_store().await;

        store
            .start_session("sess-1", "kraken", "/home/user/kraken")
            .await
            .unwrap();

        let observation = store
            .save_observation(SaveObservationParams {
                session_id: "sess-1".to_string(),
                observation_type: "discovery".to_string(),
                title: "Found a bug".to_string(),
                content: "Details here".to_string(),
                project: Some("kraken".to_string()),
                scope: None,
                topic_key: None,
                embedding: None,
            })
            .await
            .unwrap();

        store
            .delete_observation(observation.id, false)
            .await
            .unwrap();

        let get_result = store.get_observation(observation.id).await;
        assert!(get_result.is_err());
    }
}
