use serde::Serialize;
use serde_json::{Value as JsonValue, json};

use crate::cli::output::{HumanDisplay, output, output_error};
use crate::daemon::config::DaemonConfig;

#[derive(Serialize)]
struct ConfigShowOutput {
    path: String,
    content: String,
}

impl HumanDisplay for ConfigShowOutput {
    fn display_human(&self) {
        println!("# Config path: {}", self.path);
        println!("{}", self.content);
    }
}

#[derive(Serialize)]
struct ConfigPathOutput {
    path: String,
}

impl HumanDisplay for ConfigPathOutput {
    fn display_human(&self) {
        println!("{}", self.path);
    }
}

#[derive(Serialize)]
struct ConfigGetOutput {
    key: String,
    value: JsonValue,
}

impl HumanDisplay for ConfigGetOutput {
    fn display_human(&self) {
        println!("{}", format_json_value_for_human(&self.value));
    }
}

#[derive(Serialize)]
struct ConfigSetOutput {
    key: String,
    value: JsonValue,
    path: String,
}

impl HumanDisplay for ConfigSetOutput {
    fn display_human(&self) {
        println!(
            "Set {} = {} (saved to {})",
            self.key,
            format_json_value_for_human(&self.value),
            self.path
        );
    }
}

#[derive(Serialize)]
struct ConfigValidateOutput {
    valid: bool,
    path: String,
    message: String,
}

impl HumanDisplay for ConfigValidateOutput {
    fn display_human(&self) {
        println!("{}", self.message);
    }
}

/// Format a JSON value in a human-readable way (unquoted strings, etc.).
fn format_json_value_for_human(value: &JsonValue) -> String {
    match value {
        JsonValue::String(string_value) => string_value.clone(),
        non_string_value => non_string_value.to_string(),
    }
}

/// Redact values for JSON keys that look like secrets.
fn redact_sensitive_json_string(json_string: &str) -> String {
    let sensitive_key_substrings = ["key", "secret", "token", "password"];
    let mut output_lines: Vec<String> = Vec::new();

    for line in json_string.lines() {
        if let Some(colon_position) = line.find(':') {
            let key_portion = line[..colon_position]
                .trim()
                .trim_matches('"')
                .to_lowercase();
            let value_portion = line[colon_position + 1..].trim();

            let key_is_sensitive = sensitive_key_substrings
                .iter()
                .any(|sensitive_substring| key_portion.contains(sensitive_substring));

            if key_is_sensitive
                && !value_portion.is_empty()
                && value_portion != "{"
                && value_portion != "["
                && value_portion != "null"
                && value_portion != "null,"
            {
                let leading_whitespace: String = line
                    .chars()
                    .take_while(|character| character.is_whitespace())
                    .collect();
                let original_key_with_quotes = line[..colon_position].trim_end();
                let trailing_comma = if value_portion.ends_with(',') {
                    ","
                } else {
                    ""
                };
                output_lines.push(format!(
                    "{}{}: \"****\"{}",
                    leading_whitespace, original_key_with_quotes, trailing_comma
                ));
                continue;
            }
        }
        output_lines.push(line.to_string());
    }

    output_lines.join("\n")
}

/// Navigate a dot-separated path through a JSON value, returning a reference
/// to the nested value if it exists.
fn navigate_json_dot_path<'a>(root_value: &'a JsonValue, dot_path: &str) -> Option<&'a JsonValue> {
    let path_segments: Vec<&str> = dot_path.split('.').collect();
    let mut current_value = root_value;

    for segment in path_segments {
        match current_value {
            JsonValue::Object(object_map) => {
                current_value = object_map.get(segment)?;
            }
            _ => return None,
        }
    }

    Some(current_value)
}

/// Navigate a dot-separated path through a mutable JSON value, returning a
/// mutable reference to the nested value if it exists.
fn navigate_json_dot_path_mut<'a>(
    root_value: &'a mut JsonValue,
    dot_path: &str,
) -> Option<&'a mut JsonValue> {
    let path_segments: Vec<&str> = dot_path.split('.').collect();
    let mut current_value = root_value;

    for segment in &path_segments {
        if !current_value.is_object() {
            return None;
        }
        let obj = current_value.as_object_mut().unwrap();
        if !obj.contains_key(*segment) {
            obj.insert(segment.to_string(), JsonValue::Object(Default::default()));
        }
        current_value = obj.get_mut(*segment).unwrap();
    }

    Some(current_value)
}

/// Parse a string into the most appropriate JSON value type.
/// Tries boolean, then integer, then float, then falls back to a JSON string.
fn parse_value_string_to_json(value_string: &str) -> JsonValue {
    if value_string == "true" {
        return JsonValue::Bool(true);
    }
    if value_string == "false" {
        return JsonValue::Bool(false);
    }
    if let Ok(integer_value) = value_string.parse::<i64>() {
        return JsonValue::Number(integer_value.into());
    }
    if let Ok(float_value) = value_string.parse::<f64>()
        && let Some(json_number) = serde_json::Number::from_f64(float_value)
    {
        return JsonValue::Number(json_number);
    }
    JsonValue::String(value_string.to_string())
}

pub async fn execute(
    command: crate::cli::ConfigCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        crate::cli::ConfigCommands::Show => handle_show(json_mode).await,
        crate::cli::ConfigCommands::Path => handle_path(json_mode).await,
        crate::cli::ConfigCommands::Get { key } => handle_get(key, json_mode).await,
        crate::cli::ConfigCommands::Set { key, value } => handle_set(key, value, json_mode).await,
        crate::cli::ConfigCommands::Validate => handle_validate(json_mode).await,
        crate::cli::ConfigCommands::Reload => handle_reload(json_mode).await,
    }
}

async fn handle_show(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let resolved_config_path = DaemonConfig::resolve_config_path(None);
    let resolved_config_path_string = resolved_config_path.to_string_lossy().to_string();

    let loaded_config = match DaemonConfig::load(None) {
        Ok(daemon_config) => daemon_config,
        Err(load_error) => {
            output_error(
                &load_error,
                Some("run 'kraken config validate' for details"),
                json_mode,
            );
            return Ok(());
        }
    };

    let serialized_json = match loaded_config.to_json_pretty() {
        Ok(json_string) => json_string,
        Err(serialize_error) => {
            output_error(&serialize_error, None, json_mode);
            return Ok(());
        }
    };

    let redacted_json = redact_sensitive_json_string(&serialized_json);

    output(
        &ConfigShowOutput {
            path: resolved_config_path_string,
            content: redacted_json,
        },
        json_mode,
    );

    Ok(())
}

async fn handle_path(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let resolved_config_path = DaemonConfig::resolve_config_path(None);
    let resolved_config_path_string = resolved_config_path.to_string_lossy().to_string();

    output(
        &ConfigPathOutput {
            path: resolved_config_path_string,
        },
        json_mode,
    );

    Ok(())
}

async fn handle_get(
    dot_path_key: String,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let loaded_config = match DaemonConfig::load(None) {
        Ok(daemon_config) => daemon_config,
        Err(load_error) => {
            output_error(
                &load_error,
                Some("run 'kraken config validate' for details"),
                json_mode,
            );
            return Ok(());
        }
    };

    let config_as_json_value: JsonValue = match serde_json::to_value(&loaded_config) {
        Ok(json_value) => json_value,
        Err(serialize_error) => {
            output_error(
                &format!("failed to serialize config for key lookup: {serialize_error}"),
                None,
                json_mode,
            );
            return Ok(());
        }
    };

    match navigate_json_dot_path(&config_as_json_value, &dot_path_key) {
        Some(found_value) => {
            output(
                &ConfigGetOutput {
                    key: dot_path_key,
                    value: found_value.clone(),
                },
                json_mode,
            );
        }
        None => {
            output_error(
                &format!("key '{}' not found in configuration", dot_path_key),
                Some("use 'kraken config show' to see all available keys"),
                json_mode,
            );
        }
    }

    Ok(())
}

async fn handle_set(
    dot_path_key: String,
    new_value_string: String,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let resolved_config_path = DaemonConfig::resolve_config_path(None);
    let resolved_config_path_string = resolved_config_path.to_string_lossy().to_string();

    if !json_mode {
        eprintln!(
            "warning: comments in {} will not be preserved after this operation",
            resolved_config_path_string
        );
    }

    let existing_json_string = if resolved_config_path.exists() {
        match std::fs::read_to_string(&resolved_config_path) {
            Ok(file_contents) => crate::daemon::config::strip_jsonc_comments(&file_contents),
            Err(read_error) => {
                output_error(
                    &format!("failed to read config file: {read_error}"),
                    None,
                    json_mode,
                );
                return Ok(());
            }
        }
    } else {
        match DaemonConfig::default().to_json_pretty() {
            Ok(default_json) => default_json,
            Err(serialize_error) => {
                output_error(&serialize_error, None, json_mode);
                return Ok(());
            }
        }
    };

    let mut config_as_json_value: JsonValue = match serde_json::from_str(&existing_json_string) {
        Ok(json_value) => json_value,
        Err(parse_error) => {
            output_error(
                &format!("failed to parse config JSON: {parse_error}"),
                Some("run 'kraken config validate' to diagnose"),
                json_mode,
            );
            return Ok(());
        }
    };

    let parsed_new_value = parse_value_string_to_json(&new_value_string);

    match navigate_json_dot_path_mut(&mut config_as_json_value, &dot_path_key) {
        Some(target_slot) => {
            *target_slot = parsed_new_value.clone();
        }
        None => {
            output_error(
                &format!("key '{}' not found in configuration", dot_path_key),
                Some("use 'kraken config show' to see all available keys"),
                json_mode,
            );
            return Ok(());
        }
    }

    let updated_json_string = match serde_json::to_string_pretty(&config_as_json_value) {
        Ok(json_string) => json_string,
        Err(serialize_error) => {
            output_error(
                &format!("failed to serialize updated config: {serialize_error}"),
                None,
                json_mode,
            );
            return Ok(());
        }
    };

    if let Some(parent_directory) = resolved_config_path.parent()
        && !parent_directory.exists()
        && let Err(mkdir_error) = std::fs::create_dir_all(parent_directory)
    {
        output_error(
            &format!("failed to create config directory: {mkdir_error}"),
            None,
            json_mode,
        );
        return Ok(());
    }

    if let Err(write_error) = std::fs::write(&resolved_config_path, &updated_json_string) {
        output_error(
            &format!("failed to write config file: {write_error}"),
            None,
            json_mode,
        );
        return Ok(());
    }

    output(
        &ConfigSetOutput {
            key: dot_path_key,
            value: parsed_new_value,
            path: resolved_config_path_string,
        },
        json_mode,
    );

    Ok(())
}

async fn handle_validate(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let resolved_config_path = DaemonConfig::resolve_config_path(None);
    let resolved_config_path_string = resolved_config_path.to_string_lossy().to_string();

    let config = match DaemonConfig::load(None) {
        Ok(c) => c,
        Err(parse_error) => {
            output(
                &ConfigValidateOutput {
                    valid: false,
                    path: resolved_config_path_string,
                    message: format!("✗ Parse error: {parse_error}"),
                },
                json_mode,
            );
            return Ok(());
        }
    };

    match config.validate() {
        Ok(()) => {
            output(
                &ConfigValidateOutput {
                    valid: true,
                    path: resolved_config_path_string.clone(),
                    message: format!("✓ Configuration valid ({})", resolved_config_path_string),
                },
                json_mode,
            );
        }
        Err(validation_errors) => {
            let message = format!(
                "✗ Validation failed:\n{}",
                validation_errors
                    .iter()
                    .map(|e| format!("  - {e}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            output(
                &ConfigValidateOutput {
                    valid: false,
                    path: resolved_config_path_string,
                    message,
                },
                json_mode,
            );
        }
    }

    Ok(())
}

#[derive(Serialize)]
struct ConfigReloadOutput {
    status: String,
    changes: Vec<ConfigChangeOutput>,
    message: String,
}

#[derive(Serialize)]
struct ConfigChangeOutput {
    section: String,
    change_type: String,
    detail: String,
}

impl HumanDisplay for ConfigReloadOutput {
    fn display_human(&self) {
        use console::style;
        println!("{}", self.message);
        for change in &self.changes {
            let icon = match change.change_type.as_str() {
                "added" => style("+").green(),
                "removed" => style("-").red(),
                _ => style("~").yellow(),
            };
            println!(
                "  {} {} {}",
                icon,
                change.section,
                style(&change.detail).dim()
            );
        }
    }
}

async fn handle_reload(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let daemon_port = crate::daemon::config::DaemonConfig::load(None)
        .map(|c| c.services.daemon_port)
        .unwrap_or(50051);

    let url = format!("http://127.0.0.1:{daemon_port}/api/config/reload");

    let client = reqwest::Client::new();
    let response = match client.post(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            output_error(
                &format!("failed to connect to daemon: {e}"),
                Some("is the daemon running? try 'kraken daemon status'"),
                json_mode,
            );
            return Ok(());
        }
    };

    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or(json!({}));

    if status.is_success() {
        let changes: Vec<ConfigChangeOutput> = body["changes"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        Some(ConfigChangeOutput {
                            section: v["section"].as_str()?.to_string(),
                            change_type: v["change_type"].as_str()?.to_string(),
                            detail: v["detail"].as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let change_count = changes.len();
        let message = if change_count == 0 {
            "✓ Configuration reloaded (no changes detected)".to_string()
        } else {
            format!("✓ Configuration reloaded ({change_count} change(s))")
        };

        output(
            &ConfigReloadOutput {
                status: "reloaded".to_string(),
                changes,
                message,
            },
            json_mode,
        );
    } else {
        let error_message = body["error"].as_str().unwrap_or("unknown error");
        output_error(error_message, None, json_mode);
    }

    Ok(())
}
