use std::process::{Child, Command, Stdio};

use tracing::{info, warn};

/// Manages a single worker subprocess that executes a daemon task.
/// Each worker is a `bun run` process that receives the task ID and
/// daemon URL as command-line arguments. The orchestrator spawns one
/// WorkerProcess per active task and monitors it via heartbeats and
/// exit-code polling.
pub struct WorkerProcess {
    pub(crate) task_id: String,
    pub(crate) child_process: Child,
    pub(crate) working_directory: String,
}

impl WorkerProcess {
    /// Spawns a new worker subprocess for the given task.
    ///
    /// The subprocess runs:
    ///   `bun run {worker_script_path} --task-id={task_id} --daemon-url={daemon_url}`
    ///
    /// The working directory is set to `working_directory`, which in Phase 1
    /// is the repository root (no git worktree isolation yet).
    ///
    /// Both stdout and stderr are piped so the orchestrator can capture
    /// output if needed. On success, logs the spawned PID and returns the
    /// WorkerProcess handle.
    pub fn spawn(
        task_id: &str,
        working_directory: &str,
        daemon_url: &str,
        worker_script_path: &str,
    ) -> Result<Self, String> {
        let child_process = Command::new("bun")
            .arg("run")
            .arg(worker_script_path)
            .arg(format!("--task-id={task_id}"))
            .arg(format!("--daemon-url={daemon_url}"))
            .current_dir(working_directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "failed to spawn worker for task '{task_id}' in '{working_directory}': {error}"
                )
            })?;

        let spawned_process_id = child_process.id();

        info!(
            task_id = task_id,
            pid = spawned_process_id,
            working_directory = working_directory,
            worker_script_path = worker_script_path,
            "spawned worker subprocess"
        );

        Ok(Self {
            task_id: task_id.to_string(),
            child_process,
            working_directory: working_directory.to_string(),
        })
    }

    /// Returns the OS process ID of the worker subprocess.
    pub fn process_id(&self) -> u32 {
        self.child_process.id()
    }

    /// Returns the task ID this worker is executing.
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    /// Returns the working directory the worker was spawned in.
    pub fn working_directory(&self) -> &str {
        &self.working_directory
    }

    /// Non-blocking check to see if the worker has exited.
    /// Returns `Some(exit_code)` if the process has finished, or `None`
    /// if it is still running. On platforms where the exit code is
    /// unavailable, defaults to `-1`.
    pub fn try_get_exit_code(&mut self) -> Option<i32> {
        match self.child_process.try_wait() {
            Ok(Some(exit_status)) => Some(exit_status.code().unwrap_or(-1)),
            Ok(None) => None,
            Err(error) => {
                warn!(
                    task_id = %self.task_id,
                    error = %error,
                    "failed to check worker exit status"
                );
                None
            }
        }
    }

    /// Forcefully kills the worker subprocess. Logs a warning if the kill
    /// fails (the process may have already exited).
    pub fn kill_process(&mut self) {
        let worker_process_id = self.child_process.id();
        info!(
            task_id = %self.task_id,
            pid = worker_process_id,
            "killing worker subprocess"
        );

        if let Err(kill_error) = self.child_process.kill() {
            warn!(
                task_id = %self.task_id,
                pid = worker_process_id,
                error = %kill_error,
                "failed to kill worker subprocess (may have already exited)"
            );
        }
    }

    /// Blocks until the worker subprocess exits and returns its exit code.
    /// If the exit code is unavailable (e.g., killed by signal), returns `-1`.
    pub fn wait_for_exit(&mut self) -> i32 {
        match self.child_process.wait() {
            Ok(exit_status) => exit_status.code().unwrap_or(-1),
            Err(error) => {
                warn!(
                    task_id = %self.task_id,
                    error = %error,
                    "failed to wait for worker subprocess"
                );
                -1
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spawn_with_invalid_working_directory_returns_error() {
        let result = WorkerProcess::spawn(
            "test-task-id",
            "/nonexistent/directory/that/should/not/exist",
            "http://localhost:50051",
            "worker.ts",
        );

        // This should fail because `bun` likely isn't found or the directory
        // doesn't exist. Either way, we expect an Err.
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_spawn_and_kill_real_process() {
        // Spawn a simple sleep process to verify lifecycle methods
        let mut child_process = Command::new("sleep")
            .arg("60")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("should spawn sleep process");

        let process_id = child_process.id();

        let mut worker = WorkerProcess {
            task_id: "test-lifecycle".to_string(),
            child_process,
            working_directory: "/tmp".to_string(),
        };

        assert_eq!(worker.process_id(), process_id);
        assert_eq!(worker.task_id(), "test-lifecycle");
        assert_eq!(worker.working_directory(), "/tmp");

        // Process should still be running
        assert!(worker.try_get_exit_code().is_none());

        // Kill it
        worker.kill_process();

        // Wait for it to exit
        let exit_code = worker.wait_for_exit();
        // Killed processes typically return -1 (signal) on Unix
        assert!(exit_code != 0 || exit_code == -1);
    }

    #[cfg(windows)]
    #[test]
    fn test_spawn_and_kill_real_process_windows() {
        // On Windows, spawn a cmd process that waits
        let child_process = Command::new("cmd")
            .args(["/C", "timeout /t 60 /nobreak"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        // If cmd is not available in test environment, skip
        let child_process = match child_process {
            Ok(child) => child,
            Err(_) => return,
        };

        let process_id = child_process.id();

        let mut worker = WorkerProcess {
            task_id: "test-lifecycle-win".to_string(),
            child_process,
            working_directory: ".".to_string(),
        };

        assert_eq!(worker.process_id(), process_id);
        assert_eq!(worker.task_id(), "test-lifecycle-win");

        // Process should still be running
        assert!(worker.try_get_exit_code().is_none());

        // Kill it
        worker.kill_process();

        // Wait for it to exit
        let _exit_code = worker.wait_for_exit();
    }
}
