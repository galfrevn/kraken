use std::process::Command;

use console::style;
use dialoguer::Password;
use tracing::info;

use crate::cli::env_helpers::save_secret_to_env_file;
use crate::cli::output::output_error;
use crate::daemon::config::DaemonConfig;

use super::WidgetCommands;

const WIDGET_SCRIPT_FILENAME: &str = "kraken-widget.js";

pub async fn execute(
    command: WidgetCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        WidgetCommands::Setup => handle_setup(json_mode).await,
        WidgetCommands::Status => handle_status(json_mode).await,
        WidgetCommands::Tunnel => handle_tunnel(json_mode).await,
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
    println!(
        "  {} Scriptable widget at {}",
        style("✓").green().bold(),
        style(script_path.display()).cyan()
    );

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

    println!("\n{}", style("Next steps:").bold());
    println!(
        "  1. Start a tunnel:        {}",
        style("kraken widget tunnel").cyan()
    );
    println!("  2. Copy the tunnel URL");
    println!(
        "  3. Open {} in Scriptable on your iPhone",
        style(script_path.display()).cyan()
    );
    println!("  4. Set KRAKEN_URL and KRAKEN_TOKEN in the script");
    println!("  5. Add a Scriptable widget to your home screen\n");

    Ok(())
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

    let script_path = ensure_widget_script();
    println!(
        "  {} Scriptable script: {}",
        style("→").dim(),
        style(script_path.display()).cyan()
    );
    println!(
        "  {} Start a tunnel:    {}",
        style("→").dim(),
        style("kraken widget tunnel").cyan()
    );

    Ok(())
}

async fn handle_tunnel(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    if json_mode {
        return Err("tunnel requires interactive mode".into());
    }

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

    let daemon_port = DaemonConfig::load(None)
        .map(|c| c.services.daemon_port)
        .unwrap_or(50051);

    println!(
        "\n  {} Starting tunnel to localhost:{}...",
        style("●").green().bold(),
        daemon_port
    );
    println!(
        "  {} The public URL will appear below. Use it in the Scriptable widget.",
        style("→").dim()
    );
    println!(
        "  {} Press {} to stop.\n",
        style("→").dim(),
        style("Ctrl+C").bold()
    );

    let status = Command::new("cloudflared")
        .arg("tunnel")
        .arg("--url")
        .arg(format!("http://localhost:{daemon_port}"))
        .status()?;

    if !status.success() {
        return Err("cloudflared exited with error".into());
    }

    Ok(())
}
