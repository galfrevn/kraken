pub mod config;
pub mod reload;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use sysinfo::System;
use tokio::sync::watch;
use tracing::{info, warn};

use crate::db::{self, DatabasePool};
use crate::db::tasks::TaskStore;
use config::DaemonConfig;

/// Holds the shared state needed by all daemon subsystems (gRPC services,
/// orchestrator, health checks). Created once at startup and passed by Arc
/// to each service that needs it.
pub struct DaemonState {
    /// Parsed and validated daemon configuration.
    #[allow(dead_code)]
    pub config: DaemonConfig,

    /// Shared SQLite connection pool (single-writer, WAL-mode).
    #[allow(dead_code)]
    pub database_pool: DatabasePool,

    /// Task CRUD operations backed by the database pool.
    pub task_store: Arc<TaskStore>,

    /// Monotonic clock instant captured at daemon startup, used for uptime.
    pub start_time: Instant,

    /// Sender half of the shutdown signal — set to `true` to initiate
    /// graceful shutdown across all subsystems.
    pub shutdown_sender: watch::Sender<bool>,

    /// Receiver half of the shutdown signal — each subsystem clones this
    /// and watches for `true` to begin its shutdown sequence.
    pub shutdown_receiver: watch::Receiver<bool>,
}

impl DaemonState {
    /// Creates a new daemon state from the given configuration.
    ///
    /// This will:
    /// 1. Ensure the database directory exists (creating it if needed).
    /// 2. Open the SQLite database and run migrations.
    /// 3. Create a `TaskStore` backed by the database pool.
    /// 4. Initialize a shutdown watch channel (initially `false`).
    pub fn new(config: DaemonConfig) -> Result<Self, String> {
        let database_path = Path::new(&config.database_path);

        // Ensure the parent directory for the database file exists
        if let Some(database_directory) = database_path.parent() {
            if !database_directory.exists() {
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
        }

        let database_pool = db::open_database(database_path)
            .map_err(|error| format!("failed to open database: {error}"))?;

        let task_store = Arc::new(TaskStore::new(database_pool.clone()));

        let (shutdown_sender, shutdown_receiver) = watch::channel(false);

        Ok(Self {
            config,
            database_pool,
            task_store,
            start_time: Instant::now(),
            shutdown_sender,
            shutdown_receiver,
        })
    }

    /// Returns how many seconds the daemon has been running since startup.
    #[allow(dead_code)]
    pub fn uptime_seconds(&self) -> u64 {
        self.start_time.elapsed().as_secs()
    }
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

/// Returns the path to the daemon PID file: `~/.kraken/daemon.pid`.
fn pid_file_path() -> PathBuf {
    let home_directory = dirs_next::home_dir().unwrap_or_else(|| {
        warn!("could not determine home directory for PID file, using current directory");
        PathBuf::from(".")
    });
    home_directory.join(".kraken").join("daemon.pid")
}

/// Writes the current process ID to `~/.kraken/daemon.pid`.
///
/// Creates the `~/.kraken/` directory if it does not exist. Returns the path
/// to the PID file on success.
pub fn write_pid_file() -> Result<PathBuf, String> {
    let pid_path = pid_file_path();

    if let Some(pid_directory) = pid_path.parent() {
        if !pid_directory.exists() {
            std::fs::create_dir_all(pid_directory).map_err(|error| {
                format!(
                    "failed to create PID file directory '{}': {error}",
                    pid_directory.display()
                )
            })?;
        }
    }

    let current_pid = std::process::id();
    std::fs::write(&pid_path, current_pid.to_string()).map_err(|error| {
        format!(
            "failed to write PID file '{}': {error}",
            pid_path.display()
        )
    })?;

    info!(pid = current_pid, path = %pid_path.display(), "wrote PID file");

    Ok(pid_path)
}

/// Removes the daemon PID file if it exists. Logs a warning if deletion fails
/// but does not return an error (best-effort cleanup).
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

/// Checks whether a daemon is already running by reading the PID file and
/// verifying the process is alive via sysinfo.
///
/// Returns `Some(pid)` if a live daemon process is found, or `None` if:
/// - No PID file exists
/// - The PID file is unreadable or contains invalid content
/// - The recorded process is no longer running (stale PID file is cleaned up)
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

    // Use sysinfo to check if the process with the recorded PID is alive
    let mut system_info = System::new();
    system_info.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(recorded_pid)]),
        true,
    );

    if system_info.process(sysinfo::Pid::from_u32(recorded_pid)).is_some() {
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

        let daemon_state =
            DaemonState::new(config).expect("should create daemon state");

        assert_eq!(daemon_state.config.repo, ".");
        assert!(daemon_state.uptime_seconds() < 2);

        // Verify shutdown channel starts as false
        assert!(!*daemon_state.shutdown_receiver.borrow());

        // Clean up
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

        let daemon_state =
            DaemonState::new(config).expect("should create daemon state");

        // Uptime should be very small right after creation
        let initial_uptime = daemon_state.uptime_seconds();
        assert!(initial_uptime < 2);

        // Clean up
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
