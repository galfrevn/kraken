use std::process::{Child, Command};

use tracing::{info, warn};

/// Manages child processes spawned by the daemon (e.g., the Go gateway).
/// Tracks each child by a human-readable name and its OS process handle.
/// Implements `Drop` to ensure all children are killed on daemon shutdown.
pub struct ChildProcessManager {
    children: Vec<(String, Child)>,
}

impl ChildProcessManager {
    /// Creates a new, empty child process manager.
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }

    /// Spawns the Go gateway binary as a child process.
    ///
    /// The gateway receives its configuration through environment variables:
    /// - `GATEWAY_PORT`: the port the gateway should listen on
    /// - `DOTENV_PATH`: path to the .env file for additional configuration
    ///
    /// On success, the child is tracked internally and its PID is logged.
    pub fn spawn_gateway(
        &mut self,
        gateway_binary_path: &str,
        port: u16,
        dotenv_file_path: &str,
    ) -> Result<(), String> {
        let child_process = Command::new(gateway_binary_path)
            .env("GATEWAY_PORT", port.to_string())
            .env("DOTENV_PATH", dotenv_file_path)
            .spawn()
            .map_err(|error| {
                format!("failed to spawn gateway at '{gateway_binary_path}': {error}")
            })?;

        let child_pid = child_process.id();
        info!(
            pid = child_pid,
            port = port,
            binary = gateway_binary_path,
            "spawned gateway child process"
        );

        self.children.push(("gateway".to_string(), child_process));

        Ok(())
    }

    /// Kills all tracked child processes, waits for each to exit, and clears
    /// the internal tracking list. Logs each kill and the resulting exit status.
    pub fn kill_all_children(&mut self) {
        for (child_name, child_process) in self.children.iter_mut() {
            let child_pid = child_process.id();
            info!(name = %child_name, pid = child_pid, "killing child process");

            match child_process.kill() {
                Ok(()) => {
                    match child_process.wait() {
                        Ok(exit_status) => {
                            info!(
                                name = %child_name,
                                pid = child_pid,
                                status = %exit_status,
                                "child process exited"
                            );
                        }
                        Err(wait_error) => {
                            warn!(
                                name = %child_name,
                                pid = child_pid,
                                error = %wait_error,
                                "failed to wait for child process"
                            );
                        }
                    }
                }
                Err(kill_error) => {
                    warn!(
                        name = %child_name,
                        pid = child_pid,
                        error = %kill_error,
                        "failed to kill child process (may have already exited)"
                    );
                }
            }
        }

        self.children.clear();
    }

    /// Returns the health status of all tracked child processes.
    /// Each entry is a tuple of (name, is_alive) where `is_alive` is true
    /// if the process has not yet exited.
    pub fn check_children_health(&mut self) -> Vec<(String, bool)> {
        self.children
            .iter_mut()
            .map(|(child_name, child_process)| {
                // try_wait returns Ok(None) if the process is still running
                let is_alive = match child_process.try_wait() {
                    Ok(None) => true,
                    Ok(Some(_exit_status)) => false,
                    Err(_) => false,
                };
                (child_name.clone(), is_alive)
            })
            .collect()
    }
}

impl Drop for ChildProcessManager {
    fn drop(&mut self) {
        self.kill_all_children();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_child_process_manager_has_no_children() {
        let mut manager = ChildProcessManager::new();
        let health_status = manager.check_children_health();
        assert!(health_status.is_empty());
    }

    #[test]
    fn test_spawn_gateway_with_invalid_binary_returns_error() {
        let mut manager = ChildProcessManager::new();
        let result = manager.spawn_gateway(
            "/nonexistent/path/to/gateway",
            50052,
            "/tmp/.env",
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("failed to spawn gateway"));
    }

    #[test]
    fn test_kill_all_children_on_empty_manager() {
        let mut manager = ChildProcessManager::new();
        // Should not panic when there are no children
        manager.kill_all_children();
        assert!(manager.check_children_health().is_empty());
    }
}
