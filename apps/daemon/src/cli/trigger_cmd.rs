use console::style;
use dialoguer::{Input, Select};
use serde::Serialize;
use serde_json::Value as JsonValue;
use tabled::{Table, Tabled};

use crate::cli::output::{HumanDisplay, daemon_base_url, output, output_error};
use crate::daemon::config::{DaemonConfig, strip_jsonc_comments};

const TRIGGER_TYPE_OPTIONS: &[&str] = &["cron", "watcher", "webhook"];

#[derive(Tabled)]
struct TriggerTableRow {
    #[tabled(rename = "NAME")]
    trigger_name: String,
    #[tabled(rename = "TYPE")]
    trigger_type: String,
    #[tabled(rename = "SCHEDULE/PATH")]
    schedule_or_path: String,
    #[tabled(rename = "TASK TEMPLATE")]
    task_template: String,
}

#[derive(Serialize)]
pub struct TriggerListEntry {
    pub name: String,
    pub trigger_type: String,
    pub schedule_or_path: String,
    pub task_template: String,
}

#[derive(Serialize)]
pub struct TriggerListOutput {
    pub triggers: Vec<TriggerListEntry>,
}

impl HumanDisplay for TriggerListOutput {
    fn display_human(&self) {
        if self.triggers.is_empty() {
            println!(
                "No triggers configured. Use {} to add one.",
                style("kraken trigger add").cyan()
            );
            return;
        }

        let table_rows: Vec<TriggerTableRow> = self
            .triggers
            .iter()
            .map(|trigger_entry| TriggerTableRow {
                trigger_name: trigger_entry.name.clone(),
                trigger_type: trigger_entry.trigger_type.clone(),
                schedule_or_path: trigger_entry.schedule_or_path.clone(),
                task_template: trigger_entry.task_template.clone(),
            })
            .collect();

        let rendered_table = Table::new(table_rows).to_string();
        println!("{rendered_table}");
        println!("{} trigger(s) configured", self.triggers.len());
    }
}

#[derive(Serialize)]
pub struct TriggerTestOutput {
    pub trigger_name: String,
    pub status: String,
    pub message: String,
}

impl HumanDisplay for TriggerTestOutput {
    fn display_human(&self) {
        println!("Trigger '{}': {}", self.trigger_name, self.message);
    }
}

fn handle_connection_error(http_error: &reqwest::Error, json_mode: bool) {
    if http_error.is_connect() || http_error.is_timeout() {
        output_error(
            "daemon not running",
            Some("Start it with: kraken start"),
            json_mode,
        );
    } else {
        output_error(&format!("request failed: {http_error}"), None, json_mode);
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

fn ensure_triggers_object(config_json: &mut JsonValue) {
    if config_json.get("triggers").is_none() {
        config_json["triggers"] = serde_json::json!({});
    }
}

async fn handle_list(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let daemon_config = match DaemonConfig::load(None) {
        Ok(loaded_config) => loaded_config,
        Err(config_load_error) => {
            output_error(
                &format!("failed to load kraken.jsonc: {config_load_error}"),
                Some("Run 'kraken init' to create a config file"),
                json_mode,
            );
            return Ok(());
        }
    };

    let mut trigger_entries: Vec<TriggerListEntry> = Vec::new();

    for cron_trigger in &daemon_config.triggers.crons {
        trigger_entries.push(TriggerListEntry {
            name: cron_trigger.name.clone(),
            trigger_type: "cron".to_string(),
            schedule_or_path: cron_trigger.expression.clone(),
            task_template: truncate_task_template(&cron_trigger.task),
        });
    }

    for webhook_trigger in &daemon_config.triggers.webhooks {
        let joined_event_names = webhook_trigger
            .events
            .iter()
            .map(|webhook_event| webhook_event.event_type.clone())
            .collect::<Vec<_>>()
            .join(", ");
        let schedule_or_path_cell =
            format!("{} [{}]", webhook_trigger.provider, joined_event_names);
        let first_event_task = webhook_trigger
            .events
            .first()
            .map(|first_event| truncate_task_template(&first_event.task))
            .unwrap_or_else(|| "—".to_string());
        trigger_entries.push(TriggerListEntry {
            name: webhook_trigger.name.clone(),
            trigger_type: "webhook".to_string(),
            schedule_or_path: schedule_or_path_cell,
            task_template: first_event_task,
        });
    }

    for watcher_trigger in &daemon_config.triggers.watchers {
        let joined_watch_paths = watcher_trigger.paths.join(", ");
        trigger_entries.push(TriggerListEntry {
            name: watcher_trigger.name.clone(),
            trigger_type: "watcher".to_string(),
            schedule_or_path: joined_watch_paths,
            task_template: truncate_task_template(&watcher_trigger.task),
        });
    }

    for slash_command_trigger in &daemon_config.triggers.slash_commands {
        let schedule_or_path_cell = format!(
            "{}/{}",
            slash_command_trigger.provider, slash_command_trigger.channel
        );
        trigger_entries.push(TriggerListEntry {
            name: slash_command_trigger.name.clone(),
            trigger_type: "slash".to_string(),
            schedule_or_path: schedule_or_path_cell,
            task_template: truncate_task_template(&slash_command_trigger.task),
        });
    }

    let trigger_list_output = TriggerListOutput {
        triggers: trigger_entries,
    };
    output(&trigger_list_output, json_mode);
    Ok(())
}

fn truncate_task_template(task_template_text: &str) -> String {
    if task_template_text.len() > 40 {
        format!("{}…", &task_template_text[..39])
    } else {
        task_template_text.to_string()
    }
}

async fn handle_add(
    trigger_type_arg: Option<String>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let resolved_trigger_type = match trigger_type_arg {
        Some(provided_type) => {
            if !TRIGGER_TYPE_OPTIONS.contains(&provided_type.as_str()) {
                output_error(
                    &format!("unknown trigger type: {provided_type}"),
                    Some("Valid types: cron, watcher, webhook"),
                    json_mode,
                );
                return Ok(());
            }
            provided_type
        }
        None => {
            let type_index = Select::new()
                .with_prompt("Trigger type")
                .items(TRIGGER_TYPE_OPTIONS)
                .default(0)
                .interact()?;
            TRIGGER_TYPE_OPTIONS[type_index].to_string()
        }
    };

    match resolved_trigger_type.as_str() {
        "cron" => handle_add_cron(json_mode),
        "watcher" => handle_add_watcher(json_mode),
        "webhook" => handle_add_webhook(json_mode),
        _ => Ok(()),
    }
}

fn handle_add_cron(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let trigger_name: String = Input::new()
        .with_prompt("Trigger name")
        .with_initial_text("daily-review")
        .interact_text()?;

    let cron_expression: String = Input::new()
        .with_prompt("Cron expression (sec min hour day month weekday)")
        .with_initial_text("0 0 9 * * Mon-Fri")
        .interact_text()?;

    let task_template: String = Input::new()
        .with_prompt("Task prompt (what the agent should do)")
        .interact_text()?;

    let mut config_json = load_config_json()?;
    ensure_triggers_object(&mut config_json);

    let crons_array = config_json["triggers"]["crons"]
        .as_array_mut()
        .map(|array| array as &mut Vec<JsonValue>);

    let new_cron = serde_json::json!({
        "name": trigger_name,
        "expression": cron_expression,
        "task": task_template
    });

    match crons_array {
        Some(array) => array.push(new_cron),
        None => config_json["triggers"]["crons"] = serde_json::json!([new_cron]),
    }

    save_config_json(&config_json)?;

    if !json_mode {
        println!(
            "{} Cron trigger '{}' added: {}",
            style("✓").green(),
            trigger_name,
            cron_expression
        );
        println!(
            "  {}",
            style("Reload daemon with: kill -HUP $(cat ~/.kraken/daemon.pid)").dim()
        );
    }

    Ok(())
}

fn handle_add_watcher(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let trigger_name: String = Input::new()
        .with_prompt("Trigger name")
        .with_initial_text("src-watcher")
        .interact_text()?;

    let watch_paths_input: String = Input::new()
        .with_prompt("Paths to watch (comma-separated)")
        .with_initial_text("src/")
        .interact_text()?;

    let watch_paths: Vec<String> = watch_paths_input
        .split(',')
        .map(|path_segment| path_segment.trim().to_string())
        .filter(|path_segment| !path_segment.is_empty())
        .collect();

    let ignore_input: String = Input::new()
        .with_prompt("Ignore patterns (comma-separated, enter to skip)")
        .default("node_modules,target,.git".to_string())
        .interact_text()?;

    let ignore_patterns: Vec<String> = ignore_input
        .split(',')
        .map(|pattern| pattern.trim().to_string())
        .filter(|pattern| !pattern.is_empty())
        .collect();

    let debounce_ms: String = Input::new()
        .with_prompt("Debounce milliseconds")
        .default("1000".to_string())
        .interact_text()?;

    let task_template: String = Input::new()
        .with_prompt("Task prompt (what the agent should do)")
        .interact_text()?;

    let mut config_json = load_config_json()?;
    ensure_triggers_object(&mut config_json);

    let new_watcher = serde_json::json!({
        "name": trigger_name,
        "paths": watch_paths,
        "ignore": ignore_patterns,
        "debounceMs": debounce_ms.parse::<u32>().unwrap_or(1000),
        "task": task_template
    });

    let watchers_array = config_json["triggers"]["watchers"]
        .as_array_mut()
        .map(|array| array as &mut Vec<JsonValue>);

    match watchers_array {
        Some(array) => array.push(new_watcher),
        None => config_json["triggers"]["watchers"] = serde_json::json!([new_watcher]),
    }

    save_config_json(&config_json)?;

    if !json_mode {
        println!(
            "{} Watcher trigger '{}' added: {}",
            style("✓").green(),
            trigger_name,
            watch_paths_input
        );
        println!(
            "  {}",
            style("Reload daemon with: kill -HUP $(cat ~/.kraken/daemon.pid)").dim()
        );
    }

    Ok(())
}

fn handle_add_webhook(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let trigger_name: String = Input::new()
        .with_prompt("Trigger name")
        .with_initial_text("github-events")
        .interact_text()?;

    let provider_options = &["github", "gitlab"];
    let provider_index = Select::new()
        .with_prompt("Provider")
        .items(provider_options)
        .default(0)
        .interact()?;
    let provider = provider_options[provider_index].to_string();

    let webhook_secret: String = Input::new()
        .with_prompt("Webhook secret (or ${ENV_VAR} reference)")
        .with_initial_text("${GITHUB_WEBHOOK_SECRET}")
        .interact_text()?;

    let event_type: String = Input::new()
        .with_prompt("Event type (e.g. issues.opened, push, pull_request.opened)")
        .interact_text()?;

    let task_template: String = Input::new()
        .with_prompt("Task prompt (use {{event.field}} for payload data)")
        .interact_text()?;

    let mut config_json = load_config_json()?;
    ensure_triggers_object(&mut config_json);

    let new_webhook = serde_json::json!({
        "name": trigger_name,
        "provider": provider,
        "secret": webhook_secret,
        "events": [{
            "type": event_type,
            "filter": [],
            "task": task_template
        }]
    });

    let webhooks_array = config_json["triggers"]["webhooks"]
        .as_array_mut()
        .map(|array| array as &mut Vec<JsonValue>);

    match webhooks_array {
        Some(array) => array.push(new_webhook),
        None => config_json["triggers"]["webhooks"] = serde_json::json!([new_webhook]),
    }

    save_config_json(&config_json)?;

    if !json_mode {
        println!(
            "{} Webhook trigger '{}' added: {} → {}",
            style("✓").green(),
            trigger_name,
            provider,
            event_type
        );
        println!(
            "  {}",
            style("Reload daemon with: kill -HUP $(cat ~/.kraken/daemon.pid)").dim()
        );
    }

    Ok(())
}

fn handle_remove(trigger_name: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut config_json = load_config_json()?;

    let trigger_sections = ["crons", "watchers", "webhooks", "slash_commands"];
    let mut found = false;

    for section_key in &trigger_sections {
        if let Some(section_array) = config_json
            .get_mut("triggers")
            .and_then(|triggers| triggers.get_mut(*section_key))
            .and_then(|section| section.as_array_mut())
        {
            let original_length = section_array.len();
            section_array.retain(|entry| {
                entry.get("name").and_then(|name_value| name_value.as_str()) != Some(&trigger_name)
            });
            if section_array.len() < original_length {
                found = true;
            }
        }
    }

    if !found {
        output_error(
            &format!("trigger '{}' not found in config", trigger_name),
            Some("Use 'kraken trigger list' to see configured triggers"),
            json_mode,
        );
        return Ok(());
    }

    save_config_json(&config_json)?;

    if !json_mode {
        println!("{} Trigger '{}' removed", style("✓").green(), trigger_name);
        println!(
            "  {}",
            style("Reload daemon with: kill -HUP $(cat ~/.kraken/daemon.pid)").dim()
        );
    }

    Ok(())
}

async fn handle_test(
    trigger_name: String,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let test_endpoint_url = format!("{}/api/triggers/{}/test", daemon_base_url(), trigger_name);

    let http_response = match http_client.post(&test_endpoint_url).send().await {
        Ok(response) => response,
        Err(connection_error) => {
            handle_connection_error(&connection_error, json_mode);
            return Ok(());
        }
    };

    let response_status_code = http_response.status();

    if response_status_code == reqwest::StatusCode::NOT_FOUND {
        output_error(
            &format!(
                "trigger '{}' not found or endpoint not yet implemented in daemon",
                trigger_name
            ),
            Some("Check your kraken.jsonc for the trigger name"),
            json_mode,
        );
        return Ok(());
    }

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "trigger test failed (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    let test_output = TriggerTestOutput {
        trigger_name: trigger_name.clone(),
        status: "fired".to_string(),
        message: format!("Trigger '{}' fired successfully", trigger_name),
    };
    output(&test_output, json_mode);
    Ok(())
}

pub async fn execute(
    command: crate::cli::TriggerCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        crate::cli::TriggerCommands::List => handle_list(json_mode).await,
        crate::cli::TriggerCommands::Add { trigger_type } => {
            handle_add(trigger_type, json_mode).await
        }
        crate::cli::TriggerCommands::Remove { name } => handle_remove(name, json_mode),
        crate::cli::TriggerCommands::Test { trigger_name } => {
            handle_test(trigger_name, json_mode).await
        }
    }
}
