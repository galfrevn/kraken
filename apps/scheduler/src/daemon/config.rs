use std::path::{Path, PathBuf};

use serde::Deserialize;
use tracing::{info, warn};

/// Top-level daemon configuration, loaded from kraken.yml.
/// Field names use serde rename attributes to match the camelCase YAML keys
/// used throughout the Kraken configuration ecosystem.
#[derive(Debug, Clone, Deserialize)]
pub struct DaemonConfig {
    /// Path to the repository root that the daemon manages.
    #[serde(default = "default_repo")]
    pub repo: String,

    /// Path to the SQLite database file used by the daemon.
    #[serde(rename = "databasePath", default = "default_database_path")]
    pub database_path: String,

    /// Orchestrator tuning parameters (concurrency, timeouts).
    #[serde(default)]
    pub orchestrator: OrchestratorConfig,

    /// Network ports for the daemon and webhook services.
    #[serde(default)]
    pub services: ServicesConfig,

    /// Git-related configuration (branch naming, etc.).
    #[serde(default)]
    pub git: GitConfig,
}

/// Controls how the orchestrator schedules and monitors worker tasks.
#[derive(Debug, Clone, Deserialize)]
pub struct OrchestratorConfig {
    /// Maximum number of worker tasks that can run concurrently.
    #[serde(rename = "maxConcurrentTasks", default = "default_max_concurrent_tasks")]
    pub max_concurrent_tasks: u32,

    /// Seconds without a heartbeat before a worker is considered dead.
    #[serde(rename = "heartbeatTimeoutSeconds", default = "default_heartbeat_timeout_seconds")]
    pub heartbeat_timeout_seconds: u64,
}

/// Network port configuration for daemon services.
#[derive(Debug, Clone, Deserialize)]
pub struct ServicesConfig {
    /// Port the daemon gRPC server listens on.
    #[serde(rename = "daemonPort", default = "default_daemon_port")]
    pub daemon_port: u16,

    /// Port the webhook/gateway service listens on.
    #[serde(rename = "webhookPort", default = "default_webhook_port")]
    pub webhook_port: u16,
}

/// Git integration configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct GitConfig {
    /// Prefix applied to branches created by the daemon (e.g. "kraken/fix-123").
    #[serde(rename = "branchPrefix", default = "default_branch_prefix")]
    pub branch_prefix: String,
}

// ---------------------------------------------------------------------------
// Default value functions for serde
// ---------------------------------------------------------------------------

fn default_repo() -> String {
    ".".to_string()
}

fn default_database_path() -> String {
    let home_directory = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home_directory
        .join(".kraken")
        .join("daemon.db")
        .to_string_lossy()
        .to_string()
}

fn default_max_concurrent_tasks() -> u32 {
    3
}

fn default_heartbeat_timeout_seconds() -> u64 {
    300
}

fn default_daemon_port() -> u16 {
    50051
}

fn default_webhook_port() -> u16 {
    50052
}

fn default_branch_prefix() -> String {
    "kraken/".to_string()
}

// ---------------------------------------------------------------------------
// Default trait implementations
// ---------------------------------------------------------------------------

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            repo: default_repo(),
            database_path: default_database_path(),
            orchestrator: OrchestratorConfig::default(),
            services: ServicesConfig::default(),
            git: GitConfig::default(),
        }
    }
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_concurrent_tasks: default_max_concurrent_tasks(),
            heartbeat_timeout_seconds: default_heartbeat_timeout_seconds(),
        }
    }
}

impl Default for ServicesConfig {
    fn default() -> Self {
        Self {
            daemon_port: default_daemon_port(),
            webhook_port: default_webhook_port(),
        }
    }
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            branch_prefix: default_branch_prefix(),
        }
    }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

impl DaemonConfig {
    /// Loads daemon configuration using a three-tier resolution strategy:
    ///
    /// 1. An explicit `config_path` argument (highest priority).
    /// 2. The `KRAKEN_CONFIGURATION_FILE` environment variable.
    /// 3. The default location `~/.kraken/kraken.yml`.
    ///
    /// If the resolved file does not exist, returns `DaemonConfig::default()`
    /// with a log message indicating defaults are being used.
    pub fn load(config_path: Option<&Path>) -> Result<Self, String> {
        let resolved_config_path = Self::resolve_config_path(config_path);

        if !resolved_config_path.exists() {
            info!(
                path = %resolved_config_path.display(),
                "configuration file not found, using defaults"
            );
            return Ok(Self::default());
        }

        info!(path = %resolved_config_path.display(), "loading configuration");

        let file_contents = std::fs::read_to_string(&resolved_config_path)
            .map_err(|error| format!("failed to read config file: {error}"))?;

        let daemon_config: DaemonConfig = serde_yml::from_str(&file_contents)
            .map_err(|error| format!("failed to parse config YAML: {error}"))?;

        Ok(daemon_config)
    }

    /// Determines which configuration file path to use, applying the
    /// three-tier fallback: explicit arg -> env var -> default path.
    fn resolve_config_path(config_path: Option<&Path>) -> PathBuf {
        if let Some(explicit_path) = config_path {
            return explicit_path.to_path_buf();
        }

        if let Ok(env_path) = std::env::var("KRAKEN_CONFIGURATION_FILE") {
            if !env_path.is_empty() {
                return PathBuf::from(env_path);
            }
        }

        let home_directory = dirs_next::home_dir().unwrap_or_else(|| {
            warn!("could not determine home directory, falling back to current directory");
            PathBuf::from(".")
        });

        home_directory.join(".kraken").join("kraken.yml")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_default_config_values() {
        let config = DaemonConfig::default();

        assert_eq!(config.repo, ".");
        assert!(config.database_path.contains("daemon.db"));
        assert_eq!(config.orchestrator.max_concurrent_tasks, 3);
        assert_eq!(config.orchestrator.heartbeat_timeout_seconds, 300);
        assert_eq!(config.services.daemon_port, 50051);
        assert_eq!(config.services.webhook_port, 50052);
        assert_eq!(config.git.branch_prefix, "kraken/");
    }

    #[test]
    fn test_load_returns_defaults_when_file_missing() {
        let nonexistent_path = Path::new("/tmp/kraken_test_nonexistent_config.yml");
        let config = DaemonConfig::load(Some(nonexistent_path))
            .expect("should return defaults for missing file");

        assert_eq!(config.repo, ".");
        assert_eq!(config.orchestrator.max_concurrent_tasks, 3);
    }

    #[test]
    fn test_load_parses_yaml_file() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_config.yml");

        let yaml_content = r#"
repo: "/home/user/myproject"
databasePath: "/tmp/test-daemon.db"
orchestrator:
  maxConcurrentTasks: 5
  heartbeatTimeoutSeconds: 120
services:
  daemonPort: 9001
  webhookPort: 9002
git:
  branchPrefix: "auto/"
"#;

        let mut config_file = std::fs::File::create(&config_file_path)
            .expect("should create test config file");
        config_file
            .write_all(yaml_content.as_bytes())
            .expect("should write test config");

        let config = DaemonConfig::load(Some(&config_file_path))
            .expect("should parse test config");

        assert_eq!(config.repo, "/home/user/myproject");
        assert_eq!(config.database_path, "/tmp/test-daemon.db");
        assert_eq!(config.orchestrator.max_concurrent_tasks, 5);
        assert_eq!(config.orchestrator.heartbeat_timeout_seconds, 120);
        assert_eq!(config.services.daemon_port, 9001);
        assert_eq!(config.services.webhook_port, 9002);
        assert_eq!(config.git.branch_prefix, "auto/");

        let _ = std::fs::remove_file(&config_file_path);
    }

    #[test]
    fn test_load_partial_yaml_uses_defaults_for_missing_fields() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_partial_config.yml");

        let yaml_content = r#"
repo: "/custom/repo"
"#;

        let mut config_file = std::fs::File::create(&config_file_path)
            .expect("should create test config file");
        config_file
            .write_all(yaml_content.as_bytes())
            .expect("should write test config");

        let config = DaemonConfig::load(Some(&config_file_path))
            .expect("should parse partial config");

        assert_eq!(config.repo, "/custom/repo");
        // All other fields should fall back to defaults
        assert_eq!(config.orchestrator.max_concurrent_tasks, 3);
        assert_eq!(config.services.daemon_port, 50051);
        assert_eq!(config.git.branch_prefix, "kraken/");

        let _ = std::fs::remove_file(&config_file_path);
    }
}
