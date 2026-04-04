use serde::Serialize;
use std::time::Duration;

use crate::cli::output::{HumanDisplay, daemon_base_url, output, output_error};
use crate::daemon;

/// Result of a stop operation, suitable for both human and JSON output.
#[derive(Serialize)]
pub struct StopResult {
    pub stopped: bool,
    pub pid: Option<u32>,
    pub method: String,
    pub message: String,
}

impl HumanDisplay for StopResult {
    fn display_human(&self) {
        if self.stopped {
            println!("{}", self.message);
        } else {
            eprintln!("error: {}", self.message);
        }
    }
}

/// Polls the OS until the given PID is no longer alive, or until the timeout
/// elapses. Returns `true` if the process exited within the timeout window.
async fn wait_for_process_to_exit(
    target_pid: u32,
    poll_interval: Duration,
    overall_timeout: Duration,
) -> bool {
    let deadline = std::time::Instant::now() + overall_timeout;

    loop {
        let mut system_info = sysinfo::System::new();
        system_info.refresh_processes(
            sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(target_pid)]),
            true,
        );

        if system_info
            .process(sysinfo::Pid::from_u32(target_pid))
            .is_none()
        {
            return true;
        }

        if std::time::Instant::now() >= deadline {
            return false;
        }

        tokio::time::sleep(poll_interval).await;
    }
}

/// Sends an OS-level terminate signal to the given PID.
///
/// On Unix: invokes `kill -TERM {pid}` (SIGTERM, graceful).
/// On Windows: uses `taskkill /PID {pid}` without `/F` (graceful request).
fn send_os_terminate_signal(target_pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let exit_status = std::process::Command::new("kill")
            .args(["-TERM", &target_pid.to_string()])
            .status()
            .map_err(|command_error| {
                format!("failed to run kill -TERM for PID {target_pid}: {command_error}")
            })?;

        if exit_status.success() {
            Ok(())
        } else {
            Err(format!(
                "kill -TERM {target_pid} exited with status: {exit_status}"
            ))
        }
    }

    #[cfg(windows)]
    {
        let exit_status = std::process::Command::new("taskkill")
            .args(["/PID", &target_pid.to_string()])
            .status()
            .map_err(|command_error| {
                format!("failed to run taskkill for PID {target_pid}: {command_error}")
            })?;

        if exit_status.success() {
            Ok(())
        } else {
            Err(format!(
                "taskkill /PID {target_pid} exited with status: {exit_status}"
            ))
        }
    }
}

/// Sends a forceful kill signal to the given PID.
///
/// On Unix: invokes `kill -9 {pid}` (SIGKILL, non-catchable).
/// On Windows: uses `taskkill /PID {pid} /F` (forced termination).
fn send_os_force_kill(target_pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let exit_status = std::process::Command::new("kill")
            .args(["-9", &target_pid.to_string()])
            .status()
            .map_err(|command_error| {
                format!("failed to run kill -9 for PID {target_pid}: {command_error}")
            })?;

        if exit_status.success() {
            Ok(())
        } else {
            Err(format!(
                "kill -9 {target_pid} exited with status: {exit_status}"
            ))
        }
    }

    #[cfg(windows)]
    {
        let exit_status = std::process::Command::new("taskkill")
            .args(["/PID", &target_pid.to_string(), "/F"])
            .status()
            .map_err(|command_error| {
                format!("failed to run taskkill /F for PID {target_pid}: {command_error}")
            })?;

        if exit_status.success() {
            Ok(())
        } else {
            Err(format!(
                "taskkill /PID {target_pid} /F exited with status: {exit_status}"
            ))
        }
    }
}

pub async fn execute(force_kill: bool, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let recorded_daemon_pid = match daemon::is_daemon_running() {
        Some(pid) => pid,
        None => {
            let not_running_result = StopResult {
                stopped: false,
                pid: None,
                method: "none".to_string(),
                message: "Daemon is not running".to_string(),
            };
            output(&not_running_result, json_mode);
            return Ok(());
        }
    };

    let graceful_wait_timeout = Duration::from_secs(5);
    let process_poll_interval = Duration::from_millis(100);

    if !force_kill {
        // Try graceful HTTP shutdown first
        let shutdown_api_url = format!("{}/api/shutdown", daemon_base_url());
        let http_client = reqwest::Client::new();

        let http_shutdown_succeeded = match http_client.post(&shutdown_api_url).send().await {
            Ok(response) if response.status().is_success() => {
                // Wait for the process to actually exit
                wait_for_process_to_exit(
                    recorded_daemon_pid,
                    process_poll_interval,
                    graceful_wait_timeout,
                )
                .await
            }
            Ok(_) | Err(_) => false,
        };

        if http_shutdown_succeeded {
            daemon::remove_pid_file();
            let success_result = StopResult {
                stopped: true,
                pid: Some(recorded_daemon_pid),
                method: "graceful".to_string(),
                message: format!("Daemon (PID {recorded_daemon_pid}) stopped gracefully"),
            };
            output(&success_result, json_mode);
            return Ok(());
        }

        // Graceful HTTP shutdown failed or timed out — fall back to SIGTERM
        if let Err(signal_error) = send_os_terminate_signal(recorded_daemon_pid) {
            output_error(
                &format!("failed to send terminate signal: {signal_error}"),
                Some("try `kraken stop --force`"),
                json_mode,
            );
            return Ok(());
        }

        let terminated_cleanly = wait_for_process_to_exit(
            recorded_daemon_pid,
            process_poll_interval,
            graceful_wait_timeout,
        )
        .await;

        if terminated_cleanly {
            daemon::remove_pid_file();
            let success_result = StopResult {
                stopped: true,
                pid: Some(recorded_daemon_pid),
                method: "sigterm".to_string(),
                message: format!("Daemon (PID {recorded_daemon_pid}) stopped via SIGTERM"),
            };
            output(&success_result, json_mode);
            return Ok(());
        }

        // SIGTERM also timed out — escalate to force kill
        if let Err(force_kill_error) = send_os_force_kill(recorded_daemon_pid) {
            output_error(
                &format!("failed to force-kill daemon: {force_kill_error}"),
                Some("the daemon PID file may need manual removal"),
                json_mode,
            );
            return Ok(());
        }
    } else {
        // --force: skip graceful attempts and kill immediately
        if let Err(force_kill_error) = send_os_force_kill(recorded_daemon_pid) {
            output_error(
                &format!("failed to force-kill daemon: {force_kill_error}"),
                Some("the process may have already exited"),
                json_mode,
            );
            return Ok(());
        }
    }

    // Give the OS a brief moment to reap the process before removing PID file
    tokio::time::sleep(Duration::from_millis(200)).await;
    daemon::remove_pid_file();

    let kill_method = if force_kill { "force" } else { "sigkill" };
    let success_result = StopResult {
        stopped: true,
        pid: Some(recorded_daemon_pid),
        method: kill_method.to_string(),
        message: format!("Daemon (PID {recorded_daemon_pid}) killed"),
    };
    output(&success_result, json_mode);

    Ok(())
}
