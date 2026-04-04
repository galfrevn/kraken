use rusqlite::params;
use tracing::{info, warn};
use uuid::Uuid;

use super::DatabasePool;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ChannelSession {
    pub id: String,
    pub channel_type: String,
    pub chat_id: String,
    pub session_id: String,
    pub created_at: String,
    pub last_message_at: String,
    pub metadata: Option<String>,
}

pub struct ChannelSessionStore {
    pool: DatabasePool,
}

#[allow(dead_code)]
impl ChannelSessionStore {
    pub fn new(pool: DatabasePool) -> Self {
        Self { pool }
    }

    pub async fn initialize(&self) -> Result<(), String> {
        let connection = self.pool.lock().await;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS channel_sessions (
                    id              TEXT PRIMARY KEY,
                    channel_type    TEXT NOT NULL,
                    chat_id         TEXT NOT NULL,
                    session_id      TEXT NOT NULL,
                    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
                    metadata        TEXT,
                    UNIQUE(channel_type, chat_id)
                );

                CREATE INDEX IF NOT EXISTS idx_channel_sessions_type_chat
                    ON channel_sessions(channel_type, chat_id);",
            )
            .map_err(|error| format!("failed to create channel_sessions table: {error}"))?;

        info!("channel_sessions table initialized");
        Ok(())
    }

    pub async fn get_or_create_session(
        &self,
        channel_type: &str,
        chat_id: &str,
    ) -> Result<ChannelSession, String> {
        let connection = self.pool.lock().await;

        let existing: Option<ChannelSession> = connection
            .query_row(
                "SELECT id, channel_type, chat_id, session_id, created_at, last_message_at, metadata
                 FROM channel_sessions
                 WHERE channel_type = ?1 AND chat_id = ?2",
                params![channel_type, chat_id],
                |row| {
                    Ok(ChannelSession {
                        id: row.get(0)?,
                        channel_type: row.get(1)?,
                        chat_id: row.get(2)?,
                        session_id: row.get(3)?,
                        created_at: row.get(4)?,
                        last_message_at: row.get(5)?,
                        metadata: row.get(6)?,
                    })
                },
            )
            .ok();

        if let Some(session) = existing {
            return Ok(session);
        }

        let id = Uuid::new_v4().to_string();
        let session_id = Uuid::new_v4().to_string();

        connection
            .execute(
                "INSERT INTO channel_sessions (id, channel_type, chat_id, session_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, channel_type, chat_id, session_id],
            )
            .map_err(|error| format!("failed to create channel session: {error}"))?;

        info!(
            channel_type = channel_type,
            chat_id = chat_id,
            session_id = session_id,
            "created new channel session"
        );

        let session = connection
            .query_row(
                "SELECT id, channel_type, chat_id, session_id, created_at, last_message_at, metadata
                 FROM channel_sessions
                 WHERE id = ?1",
                params![id],
                |row| {
                    Ok(ChannelSession {
                        id: row.get(0)?,
                        channel_type: row.get(1)?,
                        chat_id: row.get(2)?,
                        session_id: row.get(3)?,
                        created_at: row.get(4)?,
                        last_message_at: row.get(5)?,
                        metadata: row.get(6)?,
                    })
                },
            )
            .map_err(|error| format!("failed to read created session: {error}"))?;

        Ok(session)
    }

    pub async fn update_metadata(
        &self,
        channel_type: &str,
        chat_id: &str,
        metadata: &str,
    ) -> Result<(), String> {
        let connection = self.pool.lock().await;
        connection
            .execute(
                "UPDATE channel_sessions SET metadata = ?3
                 WHERE channel_type = ?1 AND chat_id = ?2",
                params![channel_type, chat_id, metadata],
            )
            .map_err(|error| format!("failed to update metadata: {error}"))?;
        Ok(())
    }

    pub async fn update_last_message(
        &self,
        channel_type: &str,
        chat_id: &str,
    ) -> Result<(), String> {
        let connection = self.pool.lock().await;
        connection
            .execute(
                "UPDATE channel_sessions SET last_message_at = datetime('now')
                 WHERE channel_type = ?1 AND chat_id = ?2",
                params![channel_type, chat_id],
            )
            .map_err(|error| format!("failed to update last_message_at: {error}"))?;
        Ok(())
    }

    pub async fn list_sessions(
        &self,
        channel_type: Option<&str>,
    ) -> Result<Vec<ChannelSession>, String> {
        let connection = self.pool.lock().await;

        let mut statement = if let Some(filter_type) = channel_type {
            let mut prepared_statement = connection
                .prepare(
                    "SELECT id, channel_type, chat_id, session_id, created_at, last_message_at, metadata
                     FROM channel_sessions
                     WHERE channel_type = ?1
                     ORDER BY last_message_at DESC",
                )
                .map_err(|error| format!("failed to prepare query: {error}"))?;

            let sessions: Vec<ChannelSession> = prepared_statement
                .query_map(params![filter_type], |row| {
                    Ok(ChannelSession {
                        id: row.get(0)?,
                        channel_type: row.get(1)?,
                        chat_id: row.get(2)?,
                        session_id: row.get(3)?,
                        created_at: row.get(4)?,
                        last_message_at: row.get(5)?,
                        metadata: row.get(6)?,
                    })
                })
                .map_err(|error| format!("failed to query sessions: {error}"))?
                .filter_map(|result| result.ok())
                .collect();

            return Ok(sessions);
        } else {
            connection
                .prepare(
                    "SELECT id, channel_type, chat_id, session_id, created_at, last_message_at, metadata
                     FROM channel_sessions
                     ORDER BY last_message_at DESC",
                )
                .map_err(|error| format!("failed to prepare query: {error}"))?
        };

        let sessions: Vec<ChannelSession> = statement
            .query_map([], |row| {
                Ok(ChannelSession {
                    id: row.get(0)?,
                    channel_type: row.get(1)?,
                    chat_id: row.get(2)?,
                    session_id: row.get(3)?,
                    created_at: row.get(4)?,
                    last_message_at: row.get(5)?,
                    metadata: row.get(6)?,
                })
            })
            .map_err(|error| format!("failed to query sessions: {error}"))?
            .filter_map(|result| result.ok())
            .collect();

        Ok(sessions)
    }

    pub async fn delete_by_channel(
        &self,
        channel_type: &str,
        chat_id: &str,
    ) -> Result<bool, String> {
        let connection = self.pool.lock().await;
        let rows_affected = connection
            .execute(
                "DELETE FROM channel_sessions WHERE channel_type = ?1 AND chat_id = ?2",
                params![channel_type, chat_id],
            )
            .map_err(|error| format!("failed to delete session: {error}"))?;

        if rows_affected > 0 {
            info!(channel_type, chat_id, "deleted channel session via command");
        }

        Ok(rows_affected > 0)
    }

    pub async fn delete_session(&self, id: &str) -> Result<bool, String> {
        let connection = self.pool.lock().await;
        let rows_affected = connection
            .execute("DELETE FROM channel_sessions WHERE id = ?1", params![id])
            .map_err(|error| format!("failed to delete session: {error}"))?;

        if rows_affected > 0 {
            info!(session_id = id, "deleted channel session");
        } else {
            warn!(session_id = id, "channel session not found for deletion");
        }

        Ok(rows_affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;

    async fn create_test_store() -> ChannelSessionStore {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory.join(format!(
            "kraken_test_channel_sessions_{}.sqlite",
            Uuid::new_v4()
        ));

        let pool = open_database(&database_path).expect("should open test database");
        let store = ChannelSessionStore::new(pool);
        store.initialize().await.expect("should initialize");
        store
    }

    #[tokio::test]
    async fn test_get_or_create_session_creates_new() {
        let store = create_test_store().await;
        let session = store
            .get_or_create_session("telegram", "12345")
            .await
            .expect("should create session");

        assert_eq!(session.channel_type, "telegram");
        assert_eq!(session.chat_id, "12345");
        assert!(!session.session_id.is_empty());
    }

    #[tokio::test]
    async fn test_get_or_create_session_returns_existing() {
        let store = create_test_store().await;
        let first = store
            .get_or_create_session("telegram", "12345")
            .await
            .expect("should create");
        let second = store
            .get_or_create_session("telegram", "12345")
            .await
            .expect("should return existing");

        assert_eq!(first.id, second.id);
        assert_eq!(first.session_id, second.session_id);
    }

    #[tokio::test]
    async fn test_different_chats_get_different_sessions() {
        let store = create_test_store().await;
        let session_a = store
            .get_or_create_session("telegram", "111")
            .await
            .expect("should create");
        let session_b = store
            .get_or_create_session("telegram", "222")
            .await
            .expect("should create");

        assert_ne!(session_a.session_id, session_b.session_id);
    }

    #[tokio::test]
    async fn test_list_sessions() {
        let store = create_test_store().await;
        store
            .get_or_create_session("telegram", "111")
            .await
            .unwrap();
        store
            .get_or_create_session("telegram", "222")
            .await
            .unwrap();
        store.get_or_create_session("discord", "333").await.unwrap();

        let all = store.list_sessions(None).await.unwrap();
        assert_eq!(all.len(), 3);

        let telegram_only = store.list_sessions(Some("telegram")).await.unwrap();
        assert_eq!(telegram_only.len(), 2);
    }

    #[tokio::test]
    async fn test_delete_session() {
        let store = create_test_store().await;
        let session = store
            .get_or_create_session("telegram", "12345")
            .await
            .unwrap();

        let deleted = store.delete_session(&session.id).await.unwrap();
        assert!(deleted);

        let not_found = store.delete_session(&session.id).await.unwrap();
        assert!(!not_found);
    }

    #[tokio::test]
    async fn test_update_last_message() {
        let store = create_test_store().await;
        let session = store
            .get_or_create_session("telegram", "12345")
            .await
            .unwrap();
        let original_time = session.last_message_at.clone();

        tokio::time::sleep(tokio::time::Duration::from_millis(1100)).await;

        store
            .update_last_message("telegram", "12345")
            .await
            .unwrap();

        let updated = store
            .get_or_create_session("telegram", "12345")
            .await
            .unwrap();
        assert_ne!(updated.last_message_at, original_time);
    }
}
