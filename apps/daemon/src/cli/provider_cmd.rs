use console::style;
use dialoguer::Password;
use tabled::{Table, Tabled};

use crate::cli::ProviderCommands;
use crate::cli::env_helpers::{read_env_map, resolve_env_file_path, write_env_map};

const KNOWN_PROVIDERS: &[(&str, &str)] = &[("openrouter", "OPENROUTER_API_KEY")];
const MASK_MIN_LENGTH: usize = 8;
const MASK_VISIBLE_PREFIX: usize = 4;

#[derive(Tabled)]
struct ProviderRow {
    #[tabled(rename = "Provider")]
    name: String,
    #[tabled(rename = "Env Variable")]
    env_var: String,
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

    if json_mode {
        let providers: Vec<serde_json::Value> = KNOWN_PROVIDERS
            .iter()
            .map(|(name, env_var)| {
                let is_configured = env_map.contains_key(*env_var);
                serde_json::json!({
                    "provider": name,
                    "env_var": env_var,
                    "configured": is_configured,
                    "key_preview": if is_configured {
                        env_map.get(*env_var).map(|key_value| mask_key(key_value))
                    } else {
                        None
                    },
                })
            })
            .collect();
        println!("{}", serde_json::json!({ "providers": providers }));
        return Ok(());
    }

    let rows: Vec<ProviderRow> = KNOWN_PROVIDERS
        .iter()
        .map(|(name, env_var)| {
            let configured = if let Some(key) = env_map.get(*env_var) {
                format!("{} ({})", style("yes").green(), mask_key(key))
            } else {
                style("no").red().to_string()
            };
            ProviderRow {
                name: name.to_string(),
                env_var: env_var.to_string(),
                configured,
            }
        })
        .collect();

    println!("{}", Table::new(&rows));
    Ok(())
}

fn handle_configure(provider: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let provider_lower = provider.to_lowercase();
    let entry = KNOWN_PROVIDERS
        .iter()
        .find(|(name, _)| *name == provider_lower);

    let Some((provider_name, env_var)) = entry else {
        let supported_names: Vec<&str> = KNOWN_PROVIDERS.iter().map(|(name, _)| *name).collect();
        let message = format!(
            "Unknown provider '{}'. Supported: {}",
            provider,
            supported_names.join(", ")
        );
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    };

    let env_path = resolve_env_file_path();
    let mut env_map = read_env_map(&env_path);

    let already_configured = env_map.contains_key(*env_var);
    if already_configured && !json_mode {
        println!(
            "{} {} already has a key configured ({}). It will be overwritten.",
            style("Note:").yellow().bold(),
            style(provider_name).cyan(),
            mask_key(&env_map[*env_var])
        );
    }

    let api_key: String = Password::new()
        .with_prompt(format!(
            "Enter your {} API key (saved to ~/.kraken/.env as {})",
            provider_name, env_var
        ))
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
                "provider": provider_name,
                "env_var": env_var,
                "status": if already_configured { "updated" } else { "configured" },
            })
        );
    } else {
        let action = if already_configured {
            "Updated"
        } else {
            "Saved"
        };
        println!(
            "{} {} {} in {}",
            style("✓").green().bold(),
            action,
            style(env_var).cyan(),
            style("~/.kraken/.env").cyan()
        );
    }

    Ok(())
}

fn handle_remove(provider: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let provider_lower = provider.to_lowercase();
    let entry = KNOWN_PROVIDERS
        .iter()
        .find(|(name, _)| *name == provider_lower);

    let Some((provider_name, env_var)) = entry else {
        let supported_names: Vec<&str> = KNOWN_PROVIDERS.iter().map(|(name, _)| *name).collect();
        let message = format!(
            "Unknown provider '{}'. Supported: {}",
            provider,
            supported_names.join(", ")
        );
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    };

    let env_path = resolve_env_file_path();
    let mut env_map = read_env_map(&env_path);

    if env_map.remove(*env_var).is_none() {
        let message = format!("No API key found for '{}'", provider);
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).yellow());
        }
        return Ok(());
    }

    write_env_map(&env_path, &env_map)?;

    if json_mode {
        println!(
            "{}",
            serde_json::json!({
                "provider": provider_name,
                "env_var": env_var,
                "status": "removed",
            })
        );
    } else {
        println!(
            "{} Removed {} from {}",
            style("✓").green().bold(),
            style(env_var).cyan(),
            style("~/.kraken/.env").cyan()
        );
    }

    Ok(())
}
