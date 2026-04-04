use std::process::Command;
use tracing::info;

const HEALTHCHECK_TIMEOUT_SECONDS: u64 = 3;
const HEALTHCHECK_POLL_INTERVAL_MILLISECONDS: u64 = 200;

pub async fn execute(no_daemon: bool, dev: bool) -> Result<(), Box<dyn std::error::Error>> {
    if !no_daemon {
        if crate::daemon::is_daemon_running().is_some() {
            info!("daemon already running, reusing existing instance");
        } else {
            info!("starting daemon in background");
            let daemon_binary_path = std::env::current_exe()?;
            let daemon_log_file_path = dirs_next::home_dir()
                .unwrap_or_default()
                .join(".kraken")
                .join("daemon.log");
            let mut daemon_command = Command::new(&daemon_binary_path);
            daemon_command
                .arg("daemon")
                .arg("run")
                .arg("--log-file")
                .arg(&daemon_log_file_path);
            daemon_command.stdout(std::process::Stdio::null());
            daemon_command.stderr(std::process::Stdio::null());

            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                daemon_command.process_group(0);
            }

            daemon_command.spawn()?;

            let healthcheck_deadline = std::time::Instant::now()
                + std::time::Duration::from_secs(HEALTHCHECK_TIMEOUT_SECONDS);
            loop {
                if crate::cli::output::is_daemon_reachable().await {
                    info!("daemon is ready");
                    break;
                }
                if std::time::Instant::now() >= healthcheck_deadline {
                    tracing::warn!(
                        "daemon did not respond to healthcheck within {HEALTHCHECK_TIMEOUT_SECONDS}s, continuing anyway"
                    );
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(
                    HEALTHCHECK_POLL_INTERVAL_MILLISECONDS,
                ))
                .await;
            }
        }
    }

    let app_script_path = find_app_entry()?;
    info!(path = %app_script_path, dev = dev, "starting TUI app");

    let mut bun_command = Command::new("bun");
    bun_command.arg("run");
    if dev {
        bun_command.arg("--watch");
    }
    bun_command.arg(&app_script_path);

    let mut app_process = bun_command.spawn()?;

    let exit_status = app_process.wait()?;
    std::process::exit(exit_status.code().unwrap_or(1));
}

fn find_app_entry() -> Result<String, Box<dyn std::error::Error>> {
    let candidates = ["apps/app/src/index.tsx", "../app/src/index.tsx"];
    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return Ok(std::fs::canonicalize(candidate)?
                .to_string_lossy()
                .to_string());
        }
    }
    Err("app entry not found (apps/app/src/index.tsx). Run from the kraken repo root.".into())
}
