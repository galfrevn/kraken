use std::process::Command;

use console::style;
use dialoguer::Password;
use tabled::{Table, Tabled};

use crate::cli::ProviderCommands;
use crate::cli::env_helpers::{read_env_map, resolve_env_file_path, write_env_map};

const KNOWN_PROVIDERS: &[(&str, &str)] = &[("openrouter", "OPENROUTER_API_KEY"), ("copilot", "")];
const MASK_MIN_LENGTH: usize = 8;
const MASK_VISIBLE_PREFIX: usize = 4;

#[derive(Tabled)]
struct ProviderRow {
    #[tabled(rename = "Provider")]
    name: String,
    #[tabled(rename = "Auth")]
    auth_type: String,
    #[tabled(rename = "Configured")]
    configured: String,
}

fn mask_key(api_key: &str) -> String {
    if api_key.len() <= MASK_MIN_LENGTH {
        return "*".repeat(api_key.len());
    }
    let visible_prefix = &api_key[..MASK_VISIBLE_PREFIX];
    format!(
        "{}{}",
        visible_prefix,
        "*".repeat(api_key.len() - MASK_VISIBLE_PREFIX)
    )
}

fn is_copilot_configured() -> bool {
    let home = dirs_next::home_dir().unwrap_or_default();
    let auth_path = home.join(".kraken").join("auth.json");
    if !auth_path.exists() {
        return false;
    }
    match std::fs::read_to_string(&auth_path) {
        Ok(contents) => {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
                json.get("copilot").is_some()
            } else {
                false
            }
        }
        Err(_) => false,
    }
}

pub async fn execute(
    command: ProviderCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        ProviderCommands::List => handle_list(json_mode),
        ProviderCommands::Configure { provider } => handle_configure(provider, json_mode),
        ProviderCommands::Remove { provider } => handle_remove(provider, json_mode),
    }
}

fn handle_list(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let env_path = resolve_env_file_path();
    let env_map = read_env_map(&env_path);
    let copilot_ok = is_copilot_configured();

    if json_mode {
        let providers = serde_json::json!([
            {
                "provider": "openrouter",
                "configured": env_map.contains_key("OPENROUTER_API_KEY"),
                "auth": "api_key",
            },
            {
                "provider": "copilot",
                "configured": copilot_ok,
                "auth": "oauth",
            }
        ]);
        println!("{}", serde_json::json!({ "providers": providers }));
        return Ok(());
    }

    let openrouter_configured = if let Some(key) = env_map.get("OPENROUTER_API_KEY") {
        format!("{} ({})", style("yes").green(), mask_key(key))
    } else {
        style("no").red().to_string()
    };

    let copilot_configured = if copilot_ok {
        style("yes").green().to_string()
    } else {
        style("no").red().to_string()
    };

    let rows = vec![
        ProviderRow {
            name: "openrouter".to_string(),
            auth_type: "API Key".to_string(),
            configured: openrouter_configured,
        },
        ProviderRow {
            name: "copilot".to_string(),
            auth_type: "OAuth".to_string(),
            configured: copilot_configured,
        },
    ];

    println!("{}", Table::new(&rows));
    Ok(())
}

fn handle_configure(provider: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let provider_lower = provider.to_lowercase();

    if provider_lower == "copilot" {
        return handle_copilot_login(json_mode);
    }

    if provider_lower != "openrouter" {
        let message = format!(
            "Unknown provider '{}'. Supported: openrouter, copilot",
            provider
        );
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    }

    let env_var = "OPENROUTER_API_KEY";
    let env_path = resolve_env_file_path();
    let mut env_map = read_env_map(&env_path);

    let already_configured = env_map.contains_key(env_var);
    if already_configured && !json_mode {
        println!(
            "{} openrouter already has a key configured ({}). It will be overwritten.",
            style("Note:").yellow().bold(),
            mask_key(&env_map[env_var])
        );
    }

    let api_key: String = Password::new()
        .with_prompt("Enter your OpenRouter API key (saved to ~/.kraken/.env)")
        .interact()?;

    if api_key.is_empty() {
        if json_mode {
            println!(
                "{}",
                serde_json::json!({ "error": "empty API key, aborted" })
            );
        } else {
            println!("{}", style("Empty key, aborted.").red());
        }
        return Ok(());
    }

    env_map.insert(env_var.to_string(), api_key);
    write_env_map(&env_path, &env_map)?;

    if json_mode {
        println!(
            "{}",
            serde_json::json!({
                "provider": "openrouter",
                "status": if already_configured { "updated" } else { "configured" },
            })
        );
    } else {
        let action = if already_configured {
            "Updated"
        } else {
            "Configured"
        };
        println!("  {} {} openrouter", style("✓").green().bold(), action);
    }

    Ok(())
}

fn handle_copilot_login(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    if json_mode {
        return Err("copilot login requires interactive mode".into());
    }

    let script_candidates = [
        "apps/app/src/cli/copilot-login.ts",
        "../app/src/cli/copilot-login.ts",
        "src/cli/copilot-login.ts",
    ];

    let script_path = script_candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|p| p.to_string())
        .unwrap_or_else(|| "apps/app/src/cli/copilot-login.ts".to_string());

    let status = Command::new("bun").arg("run").arg(&script_path).status()?;

    if !status.success() {
        return Err("Copilot login failed".into());
    }

    Ok(())
}

fn handle_remove(provider: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let provider_lower = provider.to_lowercase();

    if provider_lower == "copilot" {
        let home = dirs_next::home_dir().unwrap_or_default();
        let auth_path = home.join(".kraken").join("auth.json");
        if auth_path.exists() {
            if let Ok(contents) = std::fs::read_to_string(&auth_path) {
                if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&contents) {
                    if let Some(obj) = json.as_object_mut() {
                        obj.remove("copilot");
                        let _ = std::fs::write(
                            &auth_path,
                            serde_json::to_string_pretty(&json).unwrap_or_default(),
                        );
                    }
                }
            }
        }
        if json_mode {
            println!(
                "{}",
                serde_json::json!({ "provider": "copilot", "status": "removed" })
            );
        } else {
            println!(
                "  {} Removed copilot authentication",
                style("✓").green().bold()
            );
        }
        return Ok(());
    }

    if provider_lower != "openrouter" {
        let message = format!(
            "Unknown provider '{}'. Supported: openrouter, copilot",
            provider
        );
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    }

    let env_var = "OPENROUTER_API_KEY";
    let env_path = resolve_env_file_path();
    let mut env_map = read_env_map(&env_path);

    if env_map.remove(env_var).is_some() {
        write_env_map(&env_path, &env_map)?;
        if json_mode {
            println!(
                "{}",
                serde_json::json!({ "provider": "openrouter", "status": "removed" })
            );
        } else {
            println!("  {} Removed openrouter API key", style("✓").green().bold());
        }
    } else if json_mode {
        println!(
            "{}",
            serde_json::json!({ "provider": "openrouter", "status": "not_configured" })
        );
    } else {
        println!("  openrouter was not configured");
    }

    Ok(())
}
