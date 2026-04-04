use std::process::Command;

use console::style;
use dialoguer::Password;
use tracing::info;

use crate::cli::env_helpers::save_secret_to_env_file;
use crate::cli::output::output_error;
use crate::daemon::config::DaemonConfig;

use super::WidgetCommands;

fn load_env_file() {
    let env_path = kraken_dir().join(".env");
    if let Ok(contents) = std::fs::read_to_string(&env_path) {
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = trimmed.split_once('=') {
                // Safety: called before any threads are spawned in CLI commands
                unsafe { std::env::set_var(key.trim(), value.trim()) };
            }
        }
    }
}

const WIDGET_SCRIPT_FILENAME: &str = "widget.js";

pub async fn execute(
    command: WidgetCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    load_env_file();
    match command {
        WidgetCommands::Setup => handle_setup(json_mode).await,
        WidgetCommands::Status => handle_status(json_mode).await,
        WidgetCommands::Tunnel(sub) => match sub {
            super::TunnelCommands::Start => handle_tunnel(json_mode).await,
            super::TunnelCommands::Stop => handle_tunnel_stop(json_mode).await,
        },
    }
}

fn kraken_dir() -> std::path::PathBuf {
    dirs_next::home_dir().unwrap_or_default().join(".kraken")
}

fn ensure_widget_script() -> std::path::PathBuf {
    let widget_dir = kraken_dir().join("widget");
    let script_path = widget_dir.join(WIDGET_SCRIPT_FILENAME);

    if !script_path.exists() {
        let _ = std::fs::create_dir_all(&widget_dir);
        let _ = std::fs::write(
            &script_path,
            include_str!("../../../../scripts/widget/kraken-widget.js"),
        );
        info!("widget script written to {}", script_path.display());
    }

    script_path
}

async fn handle_setup(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    if json_mode {
        return Err("widget setup requires interactive mode".into());
    }

    println!("\n{}\n", style("Widget Setup").bold().underlined());
    println!(
        "This will configure the /api/widget endpoint so you can\naccess Kraken status from an iOS widget (Scriptable).\n"
    );

    let token: String = Password::new()
        .with_prompt("Widget token (pick any secret string)")
        .interact()?;

    if token.trim().is_empty() {
        output_error("empty token, aborted", None, json_mode);
        return Ok(());
    }

    save_secret_to_env_file("KRAKEN_WIDGET_TOKEN", token.trim())?;
    println!(
        "  {} Saved KRAKEN_WIDGET_TOKEN to {}",
        style("✓").green().bold(),
        style("~/.kraken/.env").cyan()
    );

    let config_path = DaemonConfig::resolve_config_path(None);
    let mut config_json = if config_path.exists() {
        let raw = std::fs::read_to_string(&config_path)?;
        let stripped = crate::daemon::config::strip_jsonc_comments(&raw);
        serde_json::from_str::<serde_json::Value>(&stripped)?
    } else {
        serde_json::json!({})
    };

    config_json["widget"] = serde_json::json!({
        "token": "${KRAKEN_WIDGET_TOKEN}",
        "enabled": true,
    });

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&config_path, serde_json::to_string_pretty(&config_json)?)?;
    println!(
        "  {} Widget enabled in {}",
        style("✓").green().bold(),
        style(config_path.display()).cyan()
    );

    let script_path = ensure_widget_script();

    let daemon_port = DaemonConfig::load(None)
        .map(|c| c.services.daemon_port)
        .unwrap_or(50051);

    let client = reqwest::Client::new();
    match client
        .get(format!("http://localhost:{daemon_port}/api/health"))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let _ = client
                .post(format!("http://localhost:{daemon_port}/api/config/reload"))
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await;
            println!("  {} Daemon reloaded", style("✓").green().bold());
        }
        _ => {
            println!(
                "  {} Daemon not running. Restart it to apply changes.",
                style("!").yellow().bold()
            );
        }
    }

    // Copy script to clipboard
    let script_content = std::fs::read_to_string(&script_path).unwrap_or_default();
    let patched = script_content.replace(
        "const KRAKEN_TOKEN = \"YOUR_TOKEN_HERE\";",
        &format!("const KRAKEN_TOKEN = \"{}\";", token.trim()),
    );
    let copied = copy_to_clipboard(&patched);

    println!("\n{}", style("Widget script:").bold());
    println!("{}", style("─".repeat(60)).dim());
    println!("{patched}");
    println!("{}", style("─".repeat(60)).dim());

    if copied {
        println!(
            "\n  {} Script copied to clipboard!",
            style("✓").green().bold()
        );
    }

    println!("\n{}", style("Setup on iPhone:").bold());
    println!(
        "  1. Install {} from the App Store",
        style("Scriptable").cyan()
    );
    println!(
        "  2. Open Scriptable, tap {} to create a new script",
        style("+").bold()
    );
    println!("  3. Paste the script above (already in your clipboard)");
    println!(
        "  4. Run {} to get your public URL",
        style("kraken widget tunnel start").cyan()
    );
    println!("  5. Set the KRAKEN_URL in the script to the tunnel URL");
    println!("  6. Go to your iPhone home screen, long press to edit");
    println!(
        "  7. Tap {}, search {}",
        style("+").bold(),
        style("Scriptable").cyan()
    );
    println!(
        "  8. Add a {} widget and select this script",
        style("Medium").bold()
    );
    println!();

    Ok(())
}

fn copy_to_clipboard(text: &str) -> bool {
    use std::io::Write;
    let mut cmd = if cfg!(target_os = "macos") {
        Command::new("pbcopy")
    } else if cfg!(target_os = "linux") {
        let mut c = Command::new("xclip");
        c.arg("-selection").arg("clipboard");
        c
    } else {
        return false;
    };

    let Ok(mut child) = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };

    if let Some(ref mut stdin) = child.stdin {
        let _ = stdin.write_all(text.as_bytes());
    }

    child.wait().map(|s| s.success()).unwrap_or(false)
}

async fn handle_status(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let config = DaemonConfig::load(None).unwrap_or_default();

    if json_mode {
        let has_token = config.widget.resolved_token().is_some();
        println!(
            "{}",
            serde_json::json!({
                "enabled": config.widget.enabled,
                "has_token": has_token,
            })
        );
        return Ok(());
    }

    if !config.widget.enabled {
        println!(
            "  {} Widget is {}. Run {} to configure.",
            style("●").red(),
            style("disabled").red(),
            style("kraken widget setup").cyan()
        );
        return Ok(());
    }

    let has_token = config.widget.resolved_token().is_some();
    if !has_token {
        println!(
            "  {} Widget is enabled but {} is not set in ~/.kraken/.env",
            style("●").yellow(),
            style("KRAKEN_WIDGET_TOKEN").bold()
        );
        return Ok(());
    }

    println!(
        "  {} Widget is {}",
        style("●").green(),
        style("enabled").green()
    );

    if let Some(pid) = read_tunnel_pid()
        && is_process_alive(pid)
    {
        let url = std::fs::read_to_string(tunnel_url_path()).unwrap_or_default();
        println!("  {} Tunnel running (pid {})", style("●").green(), pid);
        if !url.is_empty() {
            println!("  {} {}", style("→").dim(), style(url.trim()).cyan());
        }
    } else {
        println!(
            "  {} Tunnel not running. Start with: {}",
            style("●").dim(),
            style("kraken widget tunnel start").cyan()
        );
    }

    Ok(())
}

fn tunnel_pid_path() -> std::path::PathBuf {
    kraken_dir().join("tunnel.pid")
}

fn tunnel_url_path() -> std::path::PathBuf {
    kraken_dir().join("tunnel.url")
}

fn tunnel_log_path() -> std::path::PathBuf {
    kraken_dir().join("tunnel.log")
}

fn read_tunnel_pid() -> Option<u32> {
    std::fs::read_to_string(tunnel_pid_path())
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

fn is_process_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn handle_tunnel(_json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    if Command::new("cloudflared")
        .arg("--version")
        .output()
        .is_err()
    {
        println!(
            "\n  {} cloudflared not found. Install it:",
            style("!").red().bold()
        );
        println!(
            "    macOS:  {}",
            style("brew install cloudflare/cloudflare/cloudflared").cyan()
        );
        println!(
            "    Linux:  {}",
            style("sudo apt install cloudflared").cyan()
        );
        return Err("cloudflared not installed".into());
    }

    if let Some(pid) = read_tunnel_pid()
        && is_process_alive(pid)
    {
        let url = std::fs::read_to_string(tunnel_url_path()).unwrap_or_default();
        println!(
            "  {} Tunnel already running (pid {})",
            style("●").green().bold(),
            pid
        );
        if !url.is_empty() {
            println!("  {} {}", style("→").dim(), style(url.trim()).cyan());
        }
        return Ok(());
    }

    let daemon_port = DaemonConfig::load(None)
        .map(|c| c.services.daemon_port)
        .unwrap_or(50051);

    let log_file = std::fs::File::create(tunnel_log_path())?;

    let child = Command::new("cloudflared")
        .arg("tunnel")
        .arg("--url")
        .arg(format!("http://localhost:{daemon_port}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::from(log_file))
        .spawn()?;

    let pid = child.id();
    std::fs::write(tunnel_pid_path(), pid.to_string())?;

    println!(
        "  {} Tunnel starting in background (pid {})...",
        style("●").green().bold(),
        pid
    );

    // Wait for cloudflared to log the URL
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(log) = std::fs::read_to_string(tunnel_log_path())
            && let Some(url) = extract_tunnel_url(&log)
        {
            std::fs::write(tunnel_url_path(), &url)?;
            println!("  {} {}", style("→").dim(), style(&url).cyan());
            println!(
                "\n  Stop with: {}",
                style("kraken widget tunnel start stop").cyan()
            );
            return Ok(());
        }
    }

    println!(
        "  {} Tunnel started but URL not detected yet. Check {}",
        style("!").yellow().bold(),
        style("~/.kraken/tunnel.log").cyan()
    );

    Ok(())
}

fn extract_tunnel_url(log: &str) -> Option<String> {
    for line in log.lines() {
        if let Some(pos) = line.find("https://") {
            let url_start = &line[pos..];
            let url_end = url_start
                .find(|c: char| c.is_whitespace())
                .unwrap_or(url_start.len());
            let url = &url_start[..url_end];
            if url.contains(".trycloudflare.com") {
                return Some(url.to_string());
            }
        }
    }
    None
}

async fn handle_tunnel_stop(_json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let Some(pid) = read_tunnel_pid() else {
        println!("  {} No tunnel running", style("●").dim());
        return Ok(());
    };

    if is_process_alive(pid) {
        let _ = Command::new("kill")
            .arg(pid.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        println!(
            "  {} Tunnel stopped (pid {})",
            style("✓").green().bold(),
            pid
        );
    } else {
        println!("  {} Tunnel was not running (stale pid)", style("●").dim());
    }

    let _ = std::fs::remove_file(tunnel_pid_path());
    let _ = std::fs::remove_file(tunnel_url_path());

    Ok(())
}
