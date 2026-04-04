use serde::{Deserialize, Serialize};

use crate::cli::output::{HumanDisplay, daemon_base_url, output, output_error};
use crate::daemon;

/// Worker thread counts: how many are currently active vs. the configured maximum.
#[derive(Serialize, Deserialize)]
pub struct WorkerStatus {
    pub active: u32,
    pub max: u32,
}

/// Task counts broken down by lifecycle status.
#[derive(Serialize, Deserialize)]
pub struct TaskCounts {
    pub pending: i32,
    pub running: i32,
    pub completed: i32,
    pub failed: i32,
}

/// Full status snapshot that the `kraken status` command renders.
///
/// Both the HTTP API (`/api/status`) and the CLI command use this struct
/// for serialization/deserialization so that JSON output is consistent.
#[derive(Serialize, Deserialize)]
pub struct StatusResponse {
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime_seconds: Option<u64>,
    pub port: Option<u16>,
    pub workers: Option<WorkerStatus>,
    pub tasks: Option<TaskCounts>,
    pub config_path: Option<String>,
}

impl HumanDisplay for StatusResponse {
    fn display_human(&self) {
        if !self.running {
            println!("Daemon:   not running");
            return;
        }

        println!("Daemon:   running");

        if let Some(daemon_pid) = self.pid {
            println!("PID:      {daemon_pid}");
        }

        if let Some(total_uptime_seconds) = self.uptime_seconds {
            let uptime_hours = total_uptime_seconds / 3600;
            let uptime_minutes = (total_uptime_seconds % 3600) / 60;
            let uptime_secs = total_uptime_seconds % 60;
            println!("Uptime:   {uptime_hours}h {uptime_minutes}m {uptime_secs}s");
        }

        if let Some(daemon_port) = self.port {
            println!("Port:     {daemon_port}");
        }

        if let Some(ref worker_status) = self.workers {
            println!("Workers:  {}/{}", worker_status.active, worker_status.max);
        }

        if let Some(ref task_counts) = self.tasks {
            println!(
                "Tasks:    {} pending, {} running, {} completed, {} failed",
                task_counts.pending, task_counts.running, task_counts.completed, task_counts.failed
            );
        }

        if let Some(ref resolved_config_path) = self.config_path {
            println!("Config:   {resolved_config_path}");
        }
    }
}

pub async fn execute(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let live_daemon_pid = daemon::is_daemon_running();

    if live_daemon_pid.is_none() {
        let not_running_status = StatusResponse {
            running: false,
            pid: None,
            uptime_seconds: None,
            port: None,
            workers: None,
            tasks: None,
            config_path: None,
        };
        output(&not_running_status, json_mode);
        return Ok(());
    }

    let recorded_daemon_pid = live_daemon_pid;

    let status_api_url = format!("{}/api/status", daemon_base_url());

    match reqwest::get(&status_api_url).await {
        Ok(http_response) if http_response.status().is_success() => {
            match http_response.json::<StatusResponse>().await {
                Ok(full_status_response) => {
                    output(&full_status_response, json_mode);
                }
                Err(deserialization_error) => {
                    output_error(
                        &format!("failed to parse daemon status response: {deserialization_error}"),
                        Some("the daemon may be running an older version"),
                        json_mode,
                    );
                    let partial_status = StatusResponse {
                        running: true,
                        pid: recorded_daemon_pid,
                        uptime_seconds: None,
                        port: None,
                        workers: None,
                        tasks: None,
                        config_path: None,
                    };
                    output(&partial_status, json_mode);
                }
            }
        }
        Ok(_) | Err(_) => {
            let partial_status = StatusResponse {
                running: true,
                pid: recorded_daemon_pid,
                uptime_seconds: None,
                port: None,
                workers: None,
                tasks: None,
                config_path: None,
            };
            output(&partial_status, json_mode);
        }
    }

    Ok(())
}
