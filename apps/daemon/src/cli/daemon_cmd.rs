use crate::cli::output::output_error;

pub struct DaemonOptions {
    pub config_path: Option<String>,
    pub log_file: Option<String>,
    pub port: Option<u16>,
}

/// Run daemon in foreground (blocks terminal). Used by `kraken daemon run`.
pub async fn execute(options: DaemonOptions) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(ref config_path) = options.config_path {
        unsafe {
            std::env::set_var("KRAKEN_CONFIG_PATH", config_path);
        }
    }
    if let Some(ref log_file) = options.log_file {
        unsafe {
            std::env::set_var("KRAKEN_DAEMON_LOG_FILE", log_file);
        }
    }
    if let Some(port) = options.port {
        unsafe {
            std::env::set_var("DAEMON_PORT", port.to_string());
        }
    }
    crate::run_daemon().await
}

/// Start daemon in background and return immediately. Used by `kraken daemon start`.
pub async fn execute_background(
    config: Option<String>,
    port: Option<u16>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if crate::daemon::is_daemon_running().is_some() {
        if json_mode {
            println!(r#"{{"status": "already_running"}}"#);
        } else {
            println!("Daemon is already running.");
        }
        return Ok(());
    }

    let daemon_binary_path = std::env::current_exe()?;
    let mut daemon_command = std::process::Command::new(&daemon_binary_path);
    daemon_command.arg("daemon").arg("run");

    if let Some(ref config_path) = config {
        daemon_command.arg("--config").arg(config_path);
    }
    if let Some(port_value) = port {
        daemon_command.arg("--port").arg(port_value.to_string());
    }

    let log_file_path = dirs_next::home_dir()
        .unwrap_or_default()
        .join(".kraken")
        .join("daemon.log");
    daemon_command.arg("--log-file").arg(&log_file_path);

    daemon_command.stdout(std::process::Stdio::null());
    daemon_command.stderr(std::process::Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        daemon_command.process_group(0);
    }

    daemon_command.spawn()?;

    // Wait for daemon to be ready
    let healthcheck_deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut daemon_is_ready = false;
    loop {
        if crate::cli::output::is_daemon_reachable().await {
            daemon_is_ready = true;
            break;
        }
        if std::time::Instant::now() >= healthcheck_deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    if daemon_is_ready {
        let daemon_port = port.unwrap_or(50051);
        if json_mode {
            println!(
                r#"{{"status": "started", "port": {daemon_port}, "log_file": "{}"}}"#,
                log_file_path.display()
            );
        } else {
            println!("Daemon started on port {daemon_port}");
            println!("Logs: {}", log_file_path.display());
        }
    } else {
        output_error(
            "daemon spawned but did not respond to healthcheck within 3s",
            Some("Check logs with: kraken logs"),
            json_mode,
        );
    }

    Ok(())
}
