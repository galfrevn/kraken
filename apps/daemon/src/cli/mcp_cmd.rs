use console::style;
use serde_json::Value as JsonValue;
use tabled::{Table, Tabled};

use crate::cli::McpCommands;
use crate::daemon::config::{DaemonConfig, McpServerConfig, strip_jsonc_comments};

#[derive(Tabled)]
struct McpServerRow {
    #[tabled(rename = "Name")]
    name: String,
    #[tabled(rename = "Type")]
    server_type: String,
    #[tabled(rename = "Target")]
    target: String,
    #[tabled(rename = "Enabled")]
    enabled: String,
}

pub async fn execute(
    command: McpCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        McpCommands::List => handle_list(json_mode),
        McpCommands::Add { name, command, url } => handle_add(name, command, url, json_mode),
        McpCommands::Remove { name } => handle_remove(name, json_mode),
        McpCommands::Enable { name } => handle_set_enabled(name, true, json_mode),
        McpCommands::Disable { name } => handle_set_enabled(name, false, json_mode),
    }
}

fn load_config_json() -> Result<JsonValue, String> {
    let config_path = DaemonConfig::resolve_config_path(None);
    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw_content = std::fs::read_to_string(&config_path)
        .map_err(|error| format!("failed to read config: {error}"))?;
    let stripped = strip_jsonc_comments(&raw_content);
    serde_json::from_str(&stripped).map_err(|error| format!("failed to parse config: {error}"))
}

fn save_config_json(config_json: &JsonValue) -> Result<(), String> {
    let config_path = DaemonConfig::resolve_config_path(None);
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create config directory: {error}"))?;
    }
    let json_string = serde_json::to_string_pretty(config_json)
        .map_err(|error| format!("failed to serialize config: {error}"))?;
    std::fs::write(&config_path, json_string)
        .map_err(|error| format!("failed to write config: {error}"))
}

fn handle_list(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let config = DaemonConfig::load(None)?;

    if config.mcp.is_empty() {
        if json_mode {
            println!("{}", serde_json::json!({ "servers": [] }));
        } else {
            println!(
                "No MCP servers configured. Use {} to add one.",
                style("kraken mcp add").cyan()
            );
        }
        return Ok(());
    }

    if json_mode {
        let servers: Vec<JsonValue> = config
            .mcp
            .iter()
            .map(|(name, server_config)| match server_config {
                McpServerConfig::Local {
                    command, enabled, ..
                } => serde_json::json!({
                    "name": name,
                    "type": "local",
                    "command": command.join(" "),
                    "enabled": enabled,
                }),
                McpServerConfig::Remote { url, enabled, .. } => serde_json::json!({
                    "name": name,
                    "type": "remote",
                    "url": url,
                    "enabled": enabled,
                }),
            })
            .collect();
        println!("{}", serde_json::json!({ "servers": servers }));
        return Ok(());
    }

    let mut rows: Vec<McpServerRow> = Vec::new();
    for (name, server_config) in &config.mcp {
        match server_config {
            McpServerConfig::Local {
                command, enabled, ..
            } => {
                rows.push(McpServerRow {
                    name: name.clone(),
                    server_type: "local".to_string(),
                    target: command.join(" "),
                    enabled: if *enabled {
                        "yes".to_string()
                    } else {
                        "no".to_string()
                    },
                });
            }
            McpServerConfig::Remote { url, enabled, .. } => {
                rows.push(McpServerRow {
                    name: name.clone(),
                    server_type: "remote".to_string(),
                    target: url.clone(),
                    enabled: if *enabled {
                        "yes".to_string()
                    } else {
                        "no".to_string()
                    },
                });
            }
        }
    }

    println!("{}", Table::new(&rows));
    Ok(())
}

fn handle_add(
    name: String,
    command: Option<String>,
    url: Option<String>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut config_json = load_config_json()?;
    let mcp_section = config_json
        .as_object_mut()
        .ok_or("config is not a JSON object")?
        .entry("mcp")
        .or_insert_with(|| serde_json::json!({}));

    if mcp_section.get(&name).is_some() {
        let message = format!("MCP server '{}' already exists", name);
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    }

    let server_entry = if let Some(command_string) = command {
        let command_parts: Vec<&str> = command_string.split_whitespace().collect();
        serde_json::json!({
            "type": "local",
            "command": command_parts,
            "enabled": true,
        })
    } else if let Some(remote_url) = url {
        serde_json::json!({
            "type": "remote",
            "url": remote_url,
            "enabled": true,
        })
    } else {
        let message = "provide --command for local servers or --url for remote servers";
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    };

    mcp_section
        .as_object_mut()
        .ok_or("mcp section is not a JSON object")?
        .insert(name.clone(), server_entry);

    save_config_json(&config_json)?;

    if json_mode {
        println!("{}", serde_json::json!({ "name": name, "status": "added" }));
    } else {
        println!(
            "{} Added MCP server {}",
            style("✓").green().bold(),
            style(&name).cyan()
        );
        println!(
            "  Reload the daemon or restart to connect: {}",
            style("kill -HUP $(cat ~/.kraken/daemon.pid)").dim()
        );
    }

    Ok(())
}

fn handle_remove(name: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut config_json = load_config_json()?;
    let mcp_section = config_json.get_mut("mcp").and_then(|v| v.as_object_mut());

    let Some(mcp_map) = mcp_section else {
        let message = format!("MCP server '{}' not found", name);
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    };

    if mcp_map.remove(&name).is_none() {
        let message = format!("MCP server '{}' not found", name);
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    }

    save_config_json(&config_json)?;

    if json_mode {
        println!(
            "{}",
            serde_json::json!({ "name": name, "status": "removed" })
        );
    } else {
        println!(
            "{} Removed MCP server {}",
            style("✓").green().bold(),
            style(&name).cyan()
        );
    }

    Ok(())
}

fn handle_set_enabled(
    name: String,
    enabled: bool,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut config_json = load_config_json()?;
    let mcp_section = config_json.get_mut("mcp").and_then(|v| v.as_object_mut());

    let Some(mcp_map) = mcp_section else {
        let message = format!("MCP server '{}' not found", name);
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    };

    let Some(server_entry) = mcp_map.get_mut(&name) else {
        let message = format!("MCP server '{}' not found", name);
        if json_mode {
            println!("{}", serde_json::json!({ "error": message }));
        } else {
            eprintln!("{}", style(message).red());
        }
        return Ok(());
    };

    if let Some(object) = server_entry.as_object_mut() {
        object.insert("enabled".to_string(), serde_json::json!(enabled));
    }

    save_config_json(&config_json)?;

    let action = if enabled { "enabled" } else { "disabled" };
    if json_mode {
        println!("{}", serde_json::json!({ "name": name, "status": action }));
    } else {
        println!(
            "{} {} MCP server {}",
            style("✓").green().bold(),
            action,
            style(&name).cyan()
        );
    }

    Ok(())
}
