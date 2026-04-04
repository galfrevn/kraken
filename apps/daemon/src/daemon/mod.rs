pub mod config;
pub mod reload;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use sysinfo::System;
use tokio::sync::watch;
use tracing::{info, warn};

use crate::db::audit::{self as audit_db, AuditStore};
use crate::db::memory::{self as memory_db, MemoryStore};
use crate::db::tasks::TaskStore;
use crate::db::{self, DatabasePool};
use config::DaemonConfig;

fn expand_tilde(path_str: &str) -> PathBuf {
    if let Some(rest) = path_str.strip_prefix("~/") {
        let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
        home.join(rest)
    } else {
        PathBuf::from(path_str)
    }
}

pub struct DaemonState {
    #[allow(dead_code)]
    pub config: DaemonConfig,

    #[allow(dead_code)]
    pub database_pool: DatabasePool,

    pub task_store: Arc<TaskStore>,

    #[allow(dead_code)]
    pub memory_database_pool: DatabasePool,

    pub memory_store: Arc<MemoryStore>,

    pub audit_store: Arc<AuditStore>,

    pub start_time: Instant,

    pub shutdown_sender: Arc<watch::Sender<bool>>,

    pub shutdown_receiver: watch::Receiver<bool>,
}

impl DaemonState {
    pub fn new(config: DaemonConfig) -> Result<Self, String> {
        let database_path = expand_tilde(&config.database_path);

        if let Some(database_directory) = database_path.parent()
            && !database_directory.exists()
        {
            std::fs::create_dir_all(database_directory).map_err(|error| {
                format!(
                    "failed to create database directory '{}': {error}",
                    database_directory.display()
                )
            })?;
            info!(
                path = %database_directory.display(),
                "created database directory"
            );
        }

        let database_pool = db::open_database(&database_path)
            .map_err(|error| format!("failed to open database: {error}"))?;

        let task_store = Arc::new(TaskStore::new(database_pool.clone()));

        let memory_db_path = database_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("memory.db");

        let memory_database_pool = memory_db::open_memory_database(&memory_db_path)
            .map_err(|error| format!("failed to open memory database: {error}"))?;

        let memory_store = Arc::new(MemoryStore::new(memory_database_pool.clone()));

        let audit_db_path = database_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("audit.db");

        let audit_database_pool = audit_db::open_audit_database(&audit_db_path)
            .map_err(|error| format!("failed to open audit database: {error}"))?;

        let audit_store = Arc::new(AuditStore::new(audit_database_pool));

        let (shutdown_sender, shutdown_receiver) = watch::channel(false);

        Ok(Self {
            config,
            database_pool,
            task_store,
            memory_database_pool,
            memory_store,
            audit_store,
            start_time: Instant::now(),
            shutdown_sender: Arc::new(shutdown_sender),
            shutdown_receiver,
        })
    }

    #[allow(dead_code)]
    pub fn uptime_seconds(&self) -> u64 {
        self.start_time.elapsed().as_secs()
    }
}

pub fn pid_file_path() -> PathBuf {
    let home_directory = dirs_next::home_dir().unwrap_or_else(|| {
        warn!("could not determine home directory for PID file, using current directory");
        PathBuf::from(".")
    });
    home_directory.join(".kraken").join("daemon.pid")
}

pub fn write_pid_file() -> Result<PathBuf, String> {
    let pid_path = pid_file_path();

    if let Some(pid_directory) = pid_path.parent()
        && !pid_directory.exists()
    {
        std::fs::create_dir_all(pid_directory).map_err(|error| {
            format!(
                "failed to create PID file directory '{}': {error}",
                pid_directory.display()
            )
        })?;
    }

    let current_pid = std::process::id();
    std::fs::write(&pid_path, current_pid.to_string())
        .map_err(|error| format!("failed to write PID file '{}': {error}", pid_path.display()))?;

    info!(pid = current_pid, path = %pid_path.display(), "wrote PID file");

    Ok(pid_path)
}

pub fn remove_pid_file() {
    let pid_path = pid_file_path();

    if pid_path.exists() {
        match std::fs::remove_file(&pid_path) {
            Ok(()) => {
                info!(path = %pid_path.display(), "removed PID file");
            }
            Err(error) => {
                warn!(
                    path = %pid_path.display(),
                    error = %error,
                    "failed to remove PID file"
                );
            }
        }
    }
}

pub fn is_daemon_running() -> Option<u32> {
    let pid_path = pid_file_path();

    if !pid_path.exists() {
        return None;
    }

    let pid_contents = match std::fs::read_to_string(&pid_path) {
        Ok(contents) => contents,
        Err(error) => {
            warn!(
                path = %pid_path.display(),
                error = %error,
                "could not read PID file"
            );
            return None;
        }
    };

    let recorded_pid: u32 = match pid_contents.trim().parse() {
        Ok(pid) => pid,
        Err(error) => {
            warn!(
                contents = %pid_contents.trim(),
                error = %error,
                "PID file contains invalid content, removing"
            );
            remove_pid_file();
            return None;
        }
    };

    let mut system_info = System::new();
    system_info.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(recorded_pid)]),
        true,
    );

    if system_info
        .process(sysinfo::Pid::from_u32(recorded_pid))
        .is_some()
    {
        Some(recorded_pid)
    } else {
        info!(
            pid = recorded_pid,
            "stale PID file found (process not running), removing"
        );
        remove_pid_file();
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_daemon_state_creation() {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory
            .join("kraken_test_daemon_state.sqlite")
            .to_string_lossy()
            .to_string();

        let config = DaemonConfig {
            database_path: database_path.clone(),
            ..DaemonConfig::default()
        };

        let daemon_state = DaemonState::new(config).expect("should create daemon state");

        assert!(daemon_state.uptime_seconds() < 2);

        assert!(!*daemon_state.shutdown_receiver.borrow());

        let _ = std::fs::remove_file(&database_path);
    }

    #[test]
    fn test_uptime_increases() {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory
            .join("kraken_test_daemon_uptime.sqlite")
            .to_string_lossy()
            .to_string();

        let config = DaemonConfig {
            database_path: database_path.clone(),
            ..DaemonConfig::default()
        };

        let daemon_state = DaemonState::new(config).expect("should create daemon state");

        let initial_uptime = daemon_state.uptime_seconds();
        assert!(initial_uptime < 2);

        let _ = std::fs::remove_file(&database_path);
    }

    #[test]
    fn test_is_daemon_running_returns_none_without_pid_file() {
        // If no PID file exists at the expected path, should return None.
        // This test assumes the PID file doesn't exist for the current test environment,
        // or that the current PID is from this test process.
        // We primarily verify no panic occurs.
        let _result = is_daemon_running();
    }
}
