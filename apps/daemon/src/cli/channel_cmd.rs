use console::style;
use dialoguer::{Input, Password, Select};
use serde::Serialize;
use serde_json::Value as JsonValue;
use tabled::{Table, Tabled};

use crate::cli::env_helpers::save_secret_to_env_file;
use crate::cli::output::{HumanDisplay, daemon_base_url, output, output_error};
use crate::daemon::config::{DaemonConfig, strip_jsonc_comments};

#[derive(Tabled)]
struct ChannelTableRow {
    #[tabled(rename = "TYPE")]
    channel_type: String,
    #[tabled(rename = "ENABLED")]
    enabled: String,
    #[tabled(rename = "DETAILS")]
    details: String,
}

#[derive(Serialize)]
pub struct ChannelListEntry {
    pub channel_type: String,
    pub enabled: bool,
    pub details: String,
}

#[derive(Serialize)]
pub struct ChannelListOutput {
    pub channels: Vec<ChannelListEntry>,
}

impl HumanDisplay for ChannelListOutput {
    fn display_human(&self) {
        if self.channels.is_empty() {
            println!(
                "No channels configured. Add one in {}",
                style("kraken.jsonc").cyan()
            );
            return;
        }

        let table_rows: Vec<ChannelTableRow> = self
            .channels
            .iter()
            .map(|entry| ChannelTableRow {
                channel_type: entry.channel_type.clone(),
                enabled: if entry.enabled {
                    style("yes").green().to_string()
                } else {
                    style("no").dim().to_string()
                },
                details: entry.details.clone(),
            })
            .collect();

        let rendered_table = Table::new(table_rows).to_string();
        println!("{rendered_table}");
    }
}

#[derive(Tabled)]
struct SessionTableRow {
    #[tabled(rename = "CHANNEL")]
    channel_type: String,
    #[tabled(rename = "CHAT ID")]
    chat_id: String,
    #[tabled(rename = "SESSION ID")]
    session_id: String,
    #[tabled(rename = "LAST MESSAGE")]
    last_message_at: String,
}

#[derive(Serialize)]
pub struct SessionListEntry {
    pub channel_type: String,
    pub chat_id: String,
    pub session_id: String,
    pub last_message_at: String,
}

#[derive(Serialize)]
pub struct SessionListOutput {
    pub sessions: Vec<SessionListEntry>,
}

impl HumanDisplay for SessionListOutput {
    fn display_human(&self) {
        if self.sessions.is_empty() {
            println!("No active channel sessions.");
            return;
        }

        let table_rows: Vec<SessionTableRow> = self
            .sessions
            .iter()
            .map(|entry| SessionTableRow {
                channel_type: entry.channel_type.clone(),
                chat_id: entry.chat_id.clone(),
                session_id: truncate_id(&entry.session_id),
                last_message_at: entry.last_message_at.clone(),
            })
            .collect();

        let rendered_table = Table::new(table_rows).to_string();
        println!("{rendered_table}");
        println!("{} session(s)", self.sessions.len());
    }
}

fn truncate_id(id: &str) -> String {
    if id.len() > 12 {
        format!("{}…", &id[..12])
    } else {
        id.to_string()
    }
}

fn handle_list(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let daemon_config = DaemonConfig::load(None).unwrap_or_default();
    let mut channels = Vec::new();

    if let Some(telegram) = &daemon_config.channels.telegram {
        channels.push(ChannelListEntry {
            channel_type: "telegram".to_string(),
            enabled: telegram.enabled,
            details: format!("dm_policy={:?}, allow_from={:?}", telegram.effective_dm_policy(), telegram.effective_allow_from()),
        });
    }

    let channel_list_output = ChannelListOutput { channels };
    output(&channel_list_output, json_mode);
    Ok(())
}

async fn handle_sessions(
    channel_type: Option<String>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let daemon_config = DaemonConfig::load(None).unwrap_or_default();
    let database_path = resolve_database_path(&daemon_config.database_path);

    if !database_path.exists() {
        let empty_output = SessionListOutput {
            sessions: Vec::new(),
        };
        output(&empty_output, json_mode);
        return Ok(());
    }

    let pool = crate::db::open_database(&database_path)
        .map_err(|error| format!("failed to open database: {error}"))?;

    let session_store = crate::db::channel_sessions::ChannelSessionStore::new(pool);
    session_store.initialize().await?;

    let sessions = session_store.list_sessions(channel_type.as_deref()).await?;

    let session_entries: Vec<SessionListEntry> = sessions
        .into_iter()
        .map(|session| SessionListEntry {
            channel_type: session.channel_type,
            chat_id: session.chat_id,
            session_id: session.session_id,
            last_message_at: session.last_message_at,
        })
        .collect();

    let session_list_output = SessionListOutput {
        sessions: session_entries,
    };
    output(&session_list_output, json_mode);
    Ok(())
}

const CHANNEL_TYPE_OPTIONS: &[&str] = &["telegram"];

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

async fn try_reload_daemon() {
    let url = format!("{}/api/config/reload", daemon_base_url());
    let client = reqwest::Client::new();

    match client.post(&url).send().await {
        Ok(response) if response.status().is_success() => {
            println!("{} Daemon config reloaded", style("✓").green().bold());
        }
        _ => {
            println!(
                "  {}",
                style("Daemon not running. Reload manually with: kill -HUP $(cat ~/.kraken/daemon.pid)").dim()
            );
        }
    }
}

async fn handle_add(
    channel_type_arg: Option<String>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let resolved_channel_type = match channel_type_arg {
        Some(provided_type) => {
            let lower = provided_type.to_lowercase();
            if !CHANNEL_TYPE_OPTIONS.contains(&lower.as_str()) {
                output_error(
                    &format!("unknown channel type: {provided_type}"),
                    Some(&format!("Valid types: {}", CHANNEL_TYPE_OPTIONS.join(", "))),
                    json_mode,
                );
                return Ok(());
            }
            lower
        }
        None => {
            let type_index = Select::new()
                .with_prompt("Channel type")
                .items(CHANNEL_TYPE_OPTIONS)
                .default(0)
                .interact()?;
            CHANNEL_TYPE_OPTIONS[type_index].to_string()
        }
    };

    match resolved_channel_type.as_str() {
        "telegram" => handle_add_telegram(json_mode).await,
        _ => Ok(()),
    }
}

async fn handle_add_telegram(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    println!();
    println!("{}", style("Telegram Channel Setup").bold().underlined());
    println!();

    let bot_token: String = Password::new()
        .with_prompt("Bot token (get one from @BotFather on Telegram)")
        .interact()?;

    if bot_token.is_empty() {
        output_error("empty bot token, aborted", None, json_mode);
        return Ok(());
    }

    let policy_options = &["Pairing (users request access with a code)", "Allowlist (only specific IDs can message)"];
    let policy_index = Select::new()
        .with_prompt("DM Policy")
        .items(policy_options)
        .default(0)
        .interact()?;

    save_secret_to_env_file("TELEGRAM_BOT_TOKEN", &bot_token)?;
    println!(
        "{} Saved {} to {}",
        style("✓").green().bold(),
        style("TELEGRAM_BOT_TOKEN").cyan(),
        style("~/.kraken/.env").cyan()
    );

    let mut config_json = load_config_json()?;

    if config_json.get("channels").is_none() {
        config_json["channels"] = serde_json::json!({});
    }

    // Ensure workerPort has a valid default
    if config_json["channels"].get("workerPort").is_none()
        || config_json["channels"]["workerPort"] == serde_json::json!(0)
    {
        config_json["channels"]["workerPort"] = serde_json::json!(7900);
    }

    if policy_index == 0 {
        // Pairing mode — no IDs needed
        config_json["channels"]["telegram"] = serde_json::json!({
            "token": "${TELEGRAM_BOT_TOKEN}",
            "dmPolicy": "pairing",
            "enabled": true
        });
    } else {
        // Allowlist mode — ask for IDs
        let ids_input: String = Input::new()
            .with_prompt("Telegram user IDs (comma-separated, get yours from @userinfobot)")
            .interact_text()?;

        let allow_from: Vec<i64> = ids_input
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<i64>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "invalid user ID — must be numeric Telegram user IDs")?;

        if allow_from.is_empty() {
            output_error("no user IDs provided, aborted", None, json_mode);
            return Ok(());
        }

        config_json["channels"]["telegram"] = serde_json::json!({
            "token": "${TELEGRAM_BOT_TOKEN}",
            "dmPolicy": "allowlist",
            "allowFrom": allow_from,
            "enabled": true
        });
    }

    save_config_json(&config_json)?;

    println!(
        "{} Telegram channel configured in {}",
        style("✓").green().bold(),
        style("~/.kraken/kraken.jsonc").cyan()
    );

    try_reload_daemon().await;

    Ok(())
}

async fn handle_remove(
    channel_name: String,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let channel_name_lower = channel_name.to_lowercase();

    if !CHANNEL_TYPE_OPTIONS.contains(&channel_name_lower.as_str()) {
        output_error(
            &format!("unknown channel type: {channel_name}"),
            Some(&format!("Valid types: {}", CHANNEL_TYPE_OPTIONS.join(", "))),
            json_mode,
        );
        return Ok(());
    }

    let mut config_json = load_config_json()?;

    let removed = config_json
        .get_mut("channels")
        .and_then(|channels| channels.as_object_mut())
        .map(|channels_map| channels_map.remove(&channel_name_lower).is_some())
        .unwrap_or(false);

    if !removed {
        output_error(
            &format!("channel '{}' not found in config", channel_name),
            Some("Use 'kraken channel list' to see configured channels"),
            json_mode,
        );
        return Ok(());
    }

    save_config_json(&config_json)?;

    if !json_mode {
        println!(
            "{} Channel '{}' removed from config",
            style("✓").green().bold(),
            channel_name_lower
        );
    }

    try_reload_daemon().await;

    Ok(())
}

pub async fn execute(
    command: crate::cli::ChannelCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        crate::cli::ChannelCommands::List => handle_list(json_mode),
        crate::cli::ChannelCommands::Sessions { channel_type } => {
            handle_sessions(channel_type, json_mode).await
        }
        crate::cli::ChannelCommands::Add { channel_type } => {
            handle_add(channel_type, json_mode).await
        }
        crate::cli::ChannelCommands::Remove { name } => handle_remove(name, json_mode).await,
    }
}

// ── Pairing Commands ──────────────────────────────────────────────────

#[derive(Tabled)]
struct PairingTableRow {
    #[tabled(rename = "CODE")]
    code: String,
    #[tabled(rename = "USER")]
    display_name: String,
    #[tabled(rename = "PLATFORM ID")]
    platform_id: String,
    #[tabled(rename = "EXPIRES")]
    expires_at: String,
}

#[derive(Serialize)]
struct PairingListOutput {
    requests: Vec<PairingListEntry>,
}

#[derive(Serialize)]
struct PairingListEntry {
    code: String,
    platform_id: String,
    display_name: Option<String>,
    expires_at: String,
}

impl HumanDisplay for PairingListOutput {
    fn display_human(&self) {
        if self.requests.is_empty() {
            println!("No pending pairing requests.");
            return;
        }

        let table_rows: Vec<PairingTableRow> = self
            .requests
            .iter()
            .map(|entry| PairingTableRow {
                code: style(&entry.code).bold().to_string(),
                display_name: entry.display_name.clone().unwrap_or_else(|| "—".into()),
                platform_id: entry.platform_id.clone(),
                expires_at: entry.expires_at.clone(),
            })
            .collect();

        let rendered_table = Table::new(table_rows).to_string();
        println!("{rendered_table}");
        println!("{} pending request(s)", self.requests.len());
    }
}

fn resolve_database_path(raw_path: &str) -> std::path::PathBuf {
    if let Some(stripped) = raw_path.strip_prefix("~/") {
        if let Some(home) = dirs_next::home_dir() {
            return home.join(stripped);
        }
    }
    std::path::PathBuf::from(raw_path)
}

fn open_user_store() -> Result<(crate::db::channel_users::ChannelUserStore, tokio::runtime::Handle), Box<dyn std::error::Error>> {
    let daemon_config = DaemonConfig::load(None).unwrap_or_default();
    let database_path = resolve_database_path(&daemon_config.database_path);

    let pool = crate::db::open_database(&database_path)
        .map_err(|error| format!("failed to open database: {error}"))?;

    let store = crate::db::channel_users::ChannelUserStore::new(pool);
    Ok((store, tokio::runtime::Handle::current()))
}

pub async fn execute_pairing(
    command: crate::cli::PairingCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (store, _) = open_user_store()?;
    store.initialize().await?;

    match command {
        crate::cli::PairingCommands::List { channel } => {
            let requests = store.get_pending_requests(&channel).await?;

            let entries: Vec<PairingListEntry> = requests
                .into_iter()
                .map(|r| PairingListEntry {
                    code: r.pairing_code,
                    platform_id: r.platform_id,
                    display_name: r.display_name,
                    expires_at: r.expires_at,
                })
                .collect();

            let list_output = PairingListOutput { requests: entries };
            output(&list_output, json_mode);
        }
        crate::cli::PairingCommands::Approve { channel, code } => {
            let code_upper = code.to_uppercase();
            match store.approve_pairing(&channel, &code_upper).await {
                Ok(user) => {
                    if json_mode {
                        println!(
                            "{}",
                            serde_json::json!({
                                "status": "approved",
                                "platform_id": user.platform_id,
                                "display_name": user.display_name,
                                "channel": user.channel_type,
                            })
                        );
                    } else {
                        println!(
                            "{} Authorized {} ({}) on {}",
                            style("✓").green().bold(),
                            style(user.display_name.as_deref().unwrap_or("unknown")).bold(),
                            user.platform_id,
                            user.channel_type,
                        );
                    }
                }
                Err(err) => {
                    output_error(&err, None, json_mode);
                }
            }
        }
        crate::cli::PairingCommands::Reject { channel, code } => {
            let code_upper = code.to_uppercase();
            match store.reject_pairing(&channel, &code_upper).await {
                Ok(request) => {
                    if json_mode {
                        println!(
                            "{}",
                            serde_json::json!({
                                "status": "rejected",
                                "platform_id": request.platform_id,
                                "channel": request.channel_type,
                            })
                        );
                    } else {
                        println!(
                            "{} Rejected pairing request from {} ({})",
                            style("✓").green().bold(),
                            request.display_name.as_deref().unwrap_or("unknown"),
                            request.platform_id,
                        );
                    }
                }
                Err(err) => {
                    output_error(&err, None, json_mode);
                }
            }
        }
    }

    Ok(())
}

// ── Users Commands ────────────────────────────────────────────────────

#[derive(Tabled)]
struct UserTableRow {
    #[tabled(rename = "CHANNEL")]
    channel_type: String,
    #[tabled(rename = "PLATFORM ID")]
    platform_id: String,
    #[tabled(rename = "NAME")]
    display_name: String,
    #[tabled(rename = "AUTHORIZED")]
    authorized_at: String,
    #[tabled(rename = "METHOD")]
    authorized_by: String,
}

#[derive(Serialize)]
struct UserListOutput {
    users: Vec<UserListEntry>,
}

#[derive(Serialize)]
struct UserListEntry {
    channel_type: String,
    platform_id: String,
    display_name: Option<String>,
    authorized_at: String,
    authorized_by: String,
}

impl HumanDisplay for UserListOutput {
    fn display_human(&self) {
        if self.users.is_empty() {
            println!("No authorized users.");
            return;
        }

        let table_rows: Vec<UserTableRow> = self
            .users
            .iter()
            .map(|entry| UserTableRow {
                channel_type: entry.channel_type.clone(),
                platform_id: entry.platform_id.clone(),
                display_name: entry.display_name.clone().unwrap_or_else(|| "—".into()),
                authorized_at: entry.authorized_at.clone(),
                authorized_by: entry.authorized_by.clone(),
            })
            .collect();

        let rendered_table = Table::new(table_rows).to_string();
        println!("{rendered_table}");
        println!("{} authorized user(s)", self.users.len());
    }
}

pub async fn execute_users(
    command: crate::cli::UsersCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (store, _) = open_user_store()?;
    store.initialize().await?;

    match command {
        crate::cli::UsersCommands::List { channel } => {
            let users = store.list_authorized(channel.as_deref()).await?;

            let entries: Vec<UserListEntry> = users
                .into_iter()
                .map(|u| UserListEntry {
                    channel_type: u.channel_type,
                    platform_id: u.platform_id,
                    display_name: u.display_name,
                    authorized_at: u.authorized_at,
                    authorized_by: u.authorized_by,
                })
                .collect();

            let list_output = UserListOutput { users: entries };
            output(&list_output, json_mode);
        }
        crate::cli::UsersCommands::Add {
            channel,
            platform_id,
            name,
        } => {
            match store
                .authorize_user(&channel, &platform_id, name.as_deref(), "cli")
                .await
            {
                Ok(user) => {
                    if json_mode {
                        println!(
                            "{}",
                            serde_json::json!({
                                "status": "authorized",
                                "platform_id": user.platform_id,
                                "channel": user.channel_type,
                            })
                        );
                    } else {
                        println!(
                            "{} Authorized {} ({}) on {}",
                            style("✓").green().bold(),
                            style(user.display_name.as_deref().unwrap_or(&platform_id)).bold(),
                            user.platform_id,
                            user.channel_type,
                        );
                    }
                }
                Err(err) => {
                    output_error(&err, None, json_mode);
                }
            }
        }
        crate::cli::UsersCommands::Remove {
            channel,
            platform_id,
        } => {
            match store.revoke_user(&channel, &platform_id).await {
                Ok(true) => {
                    if json_mode {
                        println!(
                            "{}",
                            serde_json::json!({
                                "status": "revoked",
                                "platform_id": platform_id,
                                "channel": channel,
                            })
                        );
                    } else {
                        println!(
                            "{} Revoked access for {} on {}",
                            style("✓").green().bold(),
                            platform_id,
                            channel,
                        );
                    }
                }
                Ok(false) => {
                    output_error(
                        &format!("user '{}' not found on channel '{}'", platform_id, channel),
                        None,
                        json_mode,
                    );
                }
                Err(err) => {
                    output_error(&err, None, json_mode);
                }
            }
        }
    }

    Ok(())
}
