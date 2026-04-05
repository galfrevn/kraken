use std::process::Command;

use console::style;
use tracing::info;

use crate::cli::env_helpers::{read_env_map, resolve_env_file_path, resolve_kraken_home_directory};

const HEALTHCHECK_TIMEOUT_SECONDS: u64 = 3;
const HEALTHCHECK_POLL_INTERVAL_MILLISECONDS: u64 = 200;

const API_KEY_ENV_VARS: &[&str] = &[
    "OPENROUTER_API_KEY",
    "KRAKEN_OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
];

/// Checks that at least one LLM API key is available (in ~/.kraken/.env or environment).
/// Returns Ok(()) if found, Err with a user-friendly message if not.
fn validate_api_key() -> Result<(), String> {
    // Check environment variables first
    for &key in API_KEY_ENV_VARS {
        if let Ok(value) = std::env::var(key)
            && !value.is_empty()
        {
            return Ok(());
        }
    }

    // Check ~/.kraken/.env file
    let env_file_path = resolve_env_file_path();
    let env_map = read_env_map(&env_file_path);

    for &key in API_KEY_ENV_VARS {
        if let Some(value) = env_map.get(key)
            && !value.is_empty()
        {
            return Ok(());
        }
    }

    Err(format!(
        "No LLM API key found.\n\n  \
         Kraken needs an API key to work. Run {} to configure one,\n  \
         or set one of these environment variables:\n\n    \
         OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY\n",
        style("kraken init").cyan().bold()
    ))
}

/// Resolves the app entry point, preferring the production bundle at ~/.kraken/lib/app/index.js
/// and falling back to development source paths for local development.
fn resolve_app_entry() -> Result<(String, bool), Box<dyn std::error::Error>> {
    let kraken_home = resolve_kraken_home_directory();

    // Production: bundled JS in ~/.kraken/lib/app/
    let production_entry = kraken_home.join("lib").join("app").join("index.js");
    if production_entry.exists() {
        return Ok((production_entry.to_string_lossy().to_string(), false));
    }

    // Development: TypeScript source (relative to repo root)
    let dev_candidates = ["apps/app/src/index.tsx", "../app/src/index.tsx"];
    for candidate in &dev_candidates {
        if std::path::Path::new(candidate).exists() {
            let absolute = std::fs::canonicalize(candidate)?
                .to_string_lossy()
                .to_string();
            return Ok((absolute, true));
        }
    }

    Err(
        "Kraken app not found.\n\n  \
         Expected bundled app at ~/.kraken/lib/app/index.js (production install)\n  \
         or source at apps/app/src/index.tsx (development).\n\n  \
         Reinstall: curl -fsSL https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.sh | bash"
            .into(),
    )
}

pub async fn execute(no_daemon: bool, dev: bool) -> Result<(), Box<dyn std::error::Error>> {
    // Validate API key before doing anything else
    if let Err(message) = validate_api_key() {
        eprintln!("\n  {} {message}", style("✗").red().bold());
        std::process::exit(1);
    }

    if !no_daemon {
        if crate::daemon::is_daemon_running().is_some() {
            info!("daemon already running, reusing existing instance");
        } else {
            info!("starting daemon in background");
            let daemon_binary_path = std::env::current_exe()?;
            let daemon_log_file_path = resolve_kraken_home_directory().join("daemon.log");

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

    let (app_entry_path, is_dev_source) = resolve_app_entry()?;
    info!(path = %app_entry_path, dev = dev, is_dev_source = is_dev_source, "starting TUI app");

    let mut bun_command = Command::new("bun");
    bun_command.arg("run");
    if dev && is_dev_source {
        bun_command.arg("--watch");
    }
    bun_command.arg(&app_entry_path);

    let mut app_process = bun_command.spawn()?;

    let exit_status = app_process.wait()?;
    std::process::exit(exit_status.code().unwrap_or(1));
}
