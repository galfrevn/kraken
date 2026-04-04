use rusqlite::params;
use tracing::{info, warn};
use uuid::Uuid;

use super::DatabasePool;

const PAIRING_CODE_CHARSET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH: usize = 8;
const PAIRING_EXPIRY_MINUTES: i64 = 60;
const MAX_PENDING_REQUESTS: usize = 3;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AuthorizedUser {
    pub id: String,
    pub channel_type: String,
    pub platform_id: String,
    pub display_name: Option<String>,
    pub authorized_at: String,
    pub authorized_by: String,
    pub metadata: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PairingRequest {
    pub id: String,
    pub channel_type: String,
    pub platform_id: String,
    pub display_name: Option<String>,
    pub pairing_code: String,
    pub created_at: String,
    pub expires_at: String,
    pub status: String,
}

pub struct ChannelUserStore {
    pool: DatabasePool,
}

#[allow(dead_code)]
impl ChannelUserStore {
    pub fn new(pool: DatabasePool) -> Self {
        Self { pool }
    }

    pub async fn initialize(&self) -> Result<(), String> {
        let connection = self.pool.lock().await;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS channel_authorized_users (
                    id              TEXT PRIMARY KEY,
                    channel_type    TEXT NOT NULL,
                    platform_id     TEXT NOT NULL,
                    display_name    TEXT,
                    authorized_at   TEXT NOT NULL DEFAULT (datetime('now')),
                    authorized_by   TEXT NOT NULL,
                    metadata        TEXT,
                    UNIQUE(channel_type, platform_id)
                );

                CREATE INDEX IF NOT EXISTS idx_channel_users_type_platform
                    ON channel_authorized_users(channel_type, platform_id);

                CREATE TABLE IF NOT EXISTS channel_pairing_requests (
                    id              TEXT PRIMARY KEY,
                    channel_type    TEXT NOT NULL,
                    platform_id     TEXT NOT NULL,
                    display_name    TEXT,
                    pairing_code    TEXT NOT NULL UNIQUE,
                    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    expires_at      TEXT NOT NULL,
                    status          TEXT NOT NULL DEFAULT 'pending'
                );

                CREATE INDEX IF NOT EXISTS idx_pairing_requests_code
                    ON channel_pairing_requests(pairing_code);
                CREATE INDEX IF NOT EXISTS idx_pairing_requests_status
                    ON channel_pairing_requests(status, channel_type);",
            )
            .map_err(|error| format!("failed to create channel_users tables: {error}"))?;

        info!("channel_authorized_users and channel_pairing_requests tables initialized");
        Ok(())
    }

    pub async fn is_authorized(
        &self,
        channel_type: &str,
        platform_id: &str,
    ) -> Result<bool, String> {
        let connection = self.pool.lock().await;
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM channel_authorized_users
                 WHERE channel_type = ?1 AND platform_id = ?2",
                params![channel_type, platform_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to check authorization: {error}"))?;
        Ok(count > 0)
    }

    pub async fn authorize_user(
        &self,
        channel_type: &str,
        platform_id: &str,
        display_name: Option<&str>,
        authorized_by: &str,
    ) -> Result<AuthorizedUser, String> {
        let connection = self.pool.lock().await;
        let id = Uuid::new_v4().to_string();

        connection
            .execute(
                "INSERT OR IGNORE INTO channel_authorized_users
                    (id, channel_type, platform_id, display_name, authorized_by)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, channel_type, platform_id, display_name, authorized_by],
            )
            .map_err(|error| format!("failed to authorize user: {error}"))?;

        let user = connection
            .query_row(
                "SELECT id, channel_type, platform_id, display_name, authorized_at, authorized_by, metadata
                 FROM channel_authorized_users
                 WHERE channel_type = ?1 AND platform_id = ?2",
                params![channel_type, platform_id],
                |row| {
                    Ok(AuthorizedUser {
                        id: row.get(0)?,
                        channel_type: row.get(1)?,
                        platform_id: row.get(2)?,
                        display_name: row.get(3)?,
                        authorized_at: row.get(4)?,
                        authorized_by: row.get(5)?,
                        metadata: row.get(6)?,
                    })
                },
            )
            .map_err(|error| format!("failed to read authorized user: {error}"))?;

        info!(
            channel_type = channel_type,
            platform_id = platform_id,
            authorized_by = authorized_by,
            "user authorized"
        );

        Ok(user)
    }

    pub async fn revoke_user(
        &self,
        channel_type: &str,
        platform_id: &str,
    ) -> Result<bool, String> {
        let connection = self.pool.lock().await;
        let rows_affected = connection
            .execute(
                "DELETE FROM channel_authorized_users
                 WHERE channel_type = ?1 AND platform_id = ?2",
                params![channel_type, platform_id],
            )
            .map_err(|error| format!("failed to revoke user: {error}"))?;

        if rows_affected > 0 {
            info!(
                channel_type = channel_type,
                platform_id = platform_id,
                "user access revoked"
            );
        } else {
            warn!(
                channel_type = channel_type,
                platform_id = platform_id,
                "user not found for revocation"
            );
        }

        Ok(rows_affected > 0)
    }

    pub async fn list_authorized(
        &self,
        channel_type: Option<&str>,
    ) -> Result<Vec<AuthorizedUser>, String> {
        let connection = self.pool.lock().await;

        if let Some(filter_type) = channel_type {
            let mut statement = connection
                .prepare(
                    "SELECT id, channel_type, platform_id, display_name, authorized_at, authorized_by, metadata
                     FROM channel_authorized_users
                     WHERE channel_type = ?1
                     ORDER BY authorized_at DESC",
                )
                .map_err(|error| format!("failed to prepare query: {error}"))?;

            let users: Vec<AuthorizedUser> = statement
                .query_map(params![filter_type], |row| {
                    Ok(AuthorizedUser {
                        id: row.get(0)?,
                        channel_type: row.get(1)?,
                        platform_id: row.get(2)?,
                        display_name: row.get(3)?,
                        authorized_at: row.get(4)?,
                        authorized_by: row.get(5)?,
                        metadata: row.get(6)?,
                    })
                })
                .map_err(|error| format!("failed to query users: {error}"))?
                .filter_map(|result| result.ok())
                .collect();

            return Ok(users);
        }

        let mut statement = connection
            .prepare(
                "SELECT id, channel_type, platform_id, display_name, authorized_at, authorized_by, metadata
                 FROM channel_authorized_users
                 ORDER BY authorized_at DESC",
            )
            .map_err(|error| format!("failed to prepare query: {error}"))?;

        let users: Vec<AuthorizedUser> = statement
            .query_map([], |row| {
                Ok(AuthorizedUser {
                    id: row.get(0)?,
                    channel_type: row.get(1)?,
                    platform_id: row.get(2)?,
                    display_name: row.get(3)?,
                    authorized_at: row.get(4)?,
                    authorized_by: row.get(5)?,
                    metadata: row.get(6)?,
                })
            })
            .map_err(|error| format!("failed to query users: {error}"))?
            .filter_map(|result| result.ok())
            .collect();

        Ok(users)
    }

    pub async fn create_pairing_request(
        &self,
        channel_type: &str,
        platform_id: &str,
        display_name: Option<&str>,
    ) -> Result<String, String> {
        let connection = self.pool.lock().await;

        // Check for existing pending request from this user
        let existing_code: Option<String> = connection
            .query_row(
                "SELECT pairing_code FROM channel_pairing_requests
                 WHERE channel_type = ?1 AND platform_id = ?2 AND status = 'pending'
                   AND expires_at > datetime('now')",
                params![channel_type, platform_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(code) = existing_code {
            return Ok(code);
        }

        // Check pending count cap
        let pending_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM channel_pairing_requests
                 WHERE channel_type = ?1 AND status = 'pending'
                   AND expires_at > datetime('now')",
                params![channel_type],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to count pending requests: {error}"))?;

        if pending_count >= MAX_PENDING_REQUESTS as i64 {
            return Err("too many pending pairing requests".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let code = generate_pairing_code()?;

        connection
            .execute(
                "INSERT INTO channel_pairing_requests
                    (id, channel_type, platform_id, display_name, pairing_code, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', ?6))",
                params![
                    id,
                    channel_type,
                    platform_id,
                    display_name,
                    code,
                    format!("+{PAIRING_EXPIRY_MINUTES} minutes")
                ],
            )
            .map_err(|error| format!("failed to create pairing request: {error}"))?;

        info!(
            channel_type = channel_type,
            platform_id = platform_id,
            code = code,
            "pairing request created"
        );

        Ok(code)
    }

    pub async fn get_pending_requests(
        &self,
        channel_type: &str,
    ) -> Result<Vec<PairingRequest>, String> {
        let connection = self.pool.lock().await;

        let mut statement = connection
            .prepare(
                "SELECT id, channel_type, platform_id, display_name, pairing_code,
                        created_at, expires_at, status
                 FROM channel_pairing_requests
                 WHERE channel_type = ?1 AND status = 'pending'
                   AND expires_at > datetime('now')
                 ORDER BY created_at DESC",
            )
            .map_err(|error| format!("failed to prepare query: {error}"))?;

        let requests: Vec<PairingRequest> = statement
            .query_map(params![channel_type], |row| {
                Ok(PairingRequest {
                    id: row.get(0)?,
                    channel_type: row.get(1)?,
                    platform_id: row.get(2)?,
                    display_name: row.get(3)?,
                    pairing_code: row.get(4)?,
                    created_at: row.get(5)?,
                    expires_at: row.get(6)?,
                    status: row.get(7)?,
                })
            })
            .map_err(|error| format!("failed to query pairing requests: {error}"))?
            .filter_map(|result| result.ok())
            .collect();

        Ok(requests)
    }

    pub async fn approve_pairing(
        &self,
        channel_type: &str,
        code: &str,
    ) -> Result<AuthorizedUser, String> {
        let connection = self.pool.lock().await;

        let request: PairingRequest = connection
            .query_row(
                "SELECT id, channel_type, platform_id, display_name, pairing_code,
                        created_at, expires_at, status
                 FROM channel_pairing_requests
                 WHERE channel_type = ?1 AND pairing_code = ?2 AND status = 'pending'",
                params![channel_type, code],
                |row| {
                    Ok(PairingRequest {
                        id: row.get(0)?,
                        channel_type: row.get(1)?,
                        platform_id: row.get(2)?,
                        display_name: row.get(3)?,
                        pairing_code: row.get(4)?,
                        created_at: row.get(5)?,
                        expires_at: row.get(6)?,
                        status: row.get(7)?,
                    })
                },
            )
            .map_err(|_| format!("pairing code '{code}' not found or already used"))?;

        // Check expiry
        let is_expired: bool = connection
            .query_row(
                "SELECT datetime('now') > ?1",
                params![request.expires_at],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to check expiry: {error}"))?;

        if is_expired {
            connection
                .execute(
                    "UPDATE channel_pairing_requests SET status = 'expired' WHERE id = ?1",
                    params![request.id],
                )
                .ok();
            return Err(format!("pairing code '{code}' has expired"));
        }

        // Mark request as approved
        connection
            .execute(
                "UPDATE channel_pairing_requests SET status = 'approved' WHERE id = ?1",
                params![request.id],
            )
            .map_err(|error| format!("failed to update pairing request: {error}"))?;

        // Authorize the user
        let user_id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT OR IGNORE INTO channel_authorized_users
                    (id, channel_type, platform_id, display_name, authorized_by)
                 VALUES (?1, ?2, ?3, ?4, 'pairing')",
                params![
                    user_id,
                    request.channel_type,
                    request.platform_id,
                    request.display_name
                ],
            )
            .map_err(|error| format!("failed to authorize user: {error}"))?;

        let user = connection
            .query_row(
                "SELECT id, channel_type, platform_id, display_name, authorized_at, authorized_by, metadata
                 FROM channel_authorized_users
                 WHERE channel_type = ?1 AND platform_id = ?2",
                params![request.channel_type, request.platform_id],
                |row| {
                    Ok(AuthorizedUser {
                        id: row.get(0)?,
                        channel_type: row.get(1)?,
                        platform_id: row.get(2)?,
                        display_name: row.get(3)?,
                        authorized_at: row.get(4)?,
                        authorized_by: row.get(5)?,
                        metadata: row.get(6)?,
                    })
                },
            )
            .map_err(|error| format!("failed to read authorized user: {error}"))?;

        info!(
            channel_type = &request.channel_type,
            platform_id = &request.platform_id,
            code = code,
            "pairing approved, user authorized"
        );

        Ok(user)
    }

    pub async fn reject_pairing(
        &self,
        channel_type: &str,
        code: &str,
    ) -> Result<PairingRequest, String> {
        let connection = self.pool.lock().await;

        let request: PairingRequest = connection
            .query_row(
                "SELECT id, channel_type, platform_id, display_name, pairing_code,
                        created_at, expires_at, status
                 FROM channel_pairing_requests
                 WHERE channel_type = ?1 AND pairing_code = ?2 AND status = 'pending'",
                params![channel_type, code],
                |row| {
                    Ok(PairingRequest {
                        id: row.get(0)?,
                        channel_type: row.get(1)?,
                        platform_id: row.get(2)?,
                        display_name: row.get(3)?,
                        pairing_code: row.get(4)?,
                        created_at: row.get(5)?,
                        expires_at: row.get(6)?,
                        status: row.get(7)?,
                    })
                },
            )
            .map_err(|_| format!("pairing code '{code}' not found or already used"))?;

        connection
            .execute(
                "DELETE FROM channel_pairing_requests WHERE id = ?1",
                params![request.id],
            )
            .map_err(|error| format!("failed to delete pairing request: {error}"))?;

        info!(
            channel_type = channel_type,
            code = code,
            "pairing request rejected"
        );

        Ok(request)
    }

    pub async fn cleanup_expired(&self) -> Result<usize, String> {
        let connection = self.pool.lock().await;
        let rows_affected = connection
            .execute(
                "DELETE FROM channel_pairing_requests
                 WHERE status = 'pending' AND expires_at <= datetime('now')",
                [],
            )
            .map_err(|error| format!("failed to cleanup expired requests: {error}"))?;

        if rows_affected > 0 {
            info!(count = rows_affected, "cleaned up expired pairing requests");
        }

        Ok(rows_affected)
    }

    pub async fn authorized_count(
        &self,
        channel_type: &str,
    ) -> Result<usize, String> {
        let connection = self.pool.lock().await;
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM channel_authorized_users WHERE channel_type = ?1",
                params![channel_type],
                |row| row.get(0),
            )
            .map_err(|error| format!("failed to count authorized users: {error}"))?;
        Ok(count as usize)
    }
}

fn generate_pairing_code() -> Result<String, String> {
    let mut bytes = [0u8; PAIRING_CODE_LENGTH];
    getrandom::fill(&mut bytes).map_err(|e| format!("failed to generate random bytes: {e}"))?;

    Ok(bytes
        .iter()
        .map(|b| PAIRING_CODE_CHARSET[(*b as usize) % PAIRING_CODE_CHARSET.len()] as char)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;

    async fn create_test_store() -> ChannelUserStore {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory.join(format!(
            "kraken_test_channel_users_{}.sqlite",
            Uuid::new_v4()
        ));

        let pool = open_database(&database_path).expect("should open test database");
        let store = ChannelUserStore::new(pool);
        store.initialize().await.expect("should initialize");
        store
    }

    #[tokio::test]
    async fn test_authorize_and_check() {
        let store = create_test_store().await;

        let authorized = store
            .is_authorized("telegram", "123456")
            .await
            .expect("should check");
        assert!(!authorized);

        store
            .authorize_user("telegram", "123456", Some("Alice"), "cli")
            .await
            .expect("should authorize");

        let authorized = store
            .is_authorized("telegram", "123456")
            .await
            .expect("should check");
        assert!(authorized);
    }

    #[tokio::test]
    async fn test_revoke_user() {
        let store = create_test_store().await;

        store
            .authorize_user("telegram", "123456", Some("Alice"), "cli")
            .await
            .expect("should authorize");

        let revoked = store
            .revoke_user("telegram", "123456")
            .await
            .expect("should revoke");
        assert!(revoked);

        let authorized = store
            .is_authorized("telegram", "123456")
            .await
            .expect("should check");
        assert!(!authorized);

        let not_found = store
            .revoke_user("telegram", "123456")
            .await
            .expect("should handle missing");
        assert!(!not_found);
    }

    #[tokio::test]
    async fn test_list_authorized() {
        let store = create_test_store().await;

        store
            .authorize_user("telegram", "111", Some("Alice"), "cli")
            .await
            .unwrap();
        store
            .authorize_user("telegram", "222", Some("Bob"), "pairing")
            .await
            .unwrap();
        store
            .authorize_user("discord", "333", Some("Charlie"), "cli")
            .await
            .unwrap();

        let all = store.list_authorized(None).await.unwrap();
        assert_eq!(all.len(), 3);

        let telegram_only = store.list_authorized(Some("telegram")).await.unwrap();
        assert_eq!(telegram_only.len(), 2);
    }

    #[tokio::test]
    async fn test_pairing_flow() {
        let store = create_test_store().await;

        // Create pairing request
        let code = store
            .create_pairing_request("telegram", "123456", Some("Alice"))
            .await
            .expect("should create request");
        assert_eq!(code.len(), PAIRING_CODE_LENGTH);

        // Same user gets same code
        let same_code = store
            .create_pairing_request("telegram", "123456", Some("Alice"))
            .await
            .expect("should return existing code");
        assert_eq!(code, same_code);

        // Verify pending
        let pending = store
            .get_pending_requests("telegram")
            .await
            .expect("should list pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].pairing_code, code);

        // Approve
        let user = store
            .approve_pairing("telegram", &code)
            .await
            .expect("should approve");
        assert_eq!(user.platform_id, "123456");
        assert_eq!(user.authorized_by, "pairing");

        // User is now authorized
        let authorized = store
            .is_authorized("telegram", "123456")
            .await
            .expect("should check");
        assert!(authorized);
    }

    #[tokio::test]
    async fn test_reject_pairing() {
        let store = create_test_store().await;

        let code = store
            .create_pairing_request("telegram", "123456", Some("Alice"))
            .await
            .expect("should create request");

        let rejected = store
            .reject_pairing("telegram", &code)
            .await
            .expect("should reject");
        assert_eq!(rejected.platform_id, "123456");

        // Code no longer valid
        let result = store.approve_pairing("telegram", &code).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_pairing_code_generation() {
        let code = generate_pairing_code().expect("should generate code");
        assert_eq!(code.len(), PAIRING_CODE_LENGTH);

        // All chars should be in the charset
        for ch in code.chars() {
            assert!(
                PAIRING_CODE_CHARSET.contains(&(ch as u8)),
                "unexpected char: {ch}"
            );
        }

        // Generate multiple codes — should be unique
        let code2 = generate_pairing_code().expect("should generate code");
        assert_ne!(code, code2);
    }

    #[tokio::test]
    async fn test_duplicate_authorize_is_idempotent() {
        let store = create_test_store().await;

        let first = store
            .authorize_user("telegram", "123456", Some("Alice"), "cli")
            .await
            .expect("should authorize");
        let second = store
            .authorize_user("telegram", "123456", Some("Alice Updated"), "pairing")
            .await
            .expect("should handle duplicate");

        // INSERT OR IGNORE keeps the first entry
        assert_eq!(first.id, second.id);
        assert_eq!(first.authorized_by, second.authorized_by);
    }

    #[tokio::test]
    async fn test_cleanup_expired() {
        let store = create_test_store().await;

        // Insert an already-expired request directly
        {
            let connection = store.pool.lock().await;
            connection
                .execute(
                    "INSERT INTO channel_pairing_requests
                        (id, channel_type, platform_id, pairing_code, expires_at)
                     VALUES ('expired-1', 'telegram', '999', 'XXXXXXXX', datetime('now', '-1 hour'))",
                    [],
                )
                .unwrap();
        }

        let cleaned = store.cleanup_expired().await.expect("should cleanup");
        assert_eq!(cleaned, 1);
    }
}
