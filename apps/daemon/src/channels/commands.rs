use std::sync::Arc;

use tracing::{info, warn};

use crate::daemon::config::DaemonConfig;
use crate::db::channel_sessions::ChannelSessionStore;
use crate::db::channel_users::ChannelUserStore;

pub struct SlashCommand {
    pub name: String,
    pub args: String,
}

pub fn parse_slash_command(text: &str) -> Option<SlashCommand> {
    let trimmed = text.trim();
    if !trimmed.starts_with('/') {
        return None;
    }
    let without_slash = &trimmed[1..];
    if without_slash.is_empty() {
        return None;
    }
    // Ignore Telegram's @botname suffix (e.g. /help@MyBot)
    let (name, args) = match without_slash.split_once(' ') {
        Some((n, a)) => (n.to_string(), a.trim().to_string()),
        None => (without_slash.to_string(), String::new()),
    };
    let name = name.split('@').next().unwrap_or(&name).to_lowercase();
    Some(SlashCommand { name, args })
}

pub struct CommandContext {
    pub session_store: Arc<ChannelSessionStore>,
    pub user_store: Arc<ChannelUserStore>,
    pub daemon_port: u16,
}

/// Handles a built-in slash command. Returns Some(response_html) if handled, None if unknown.
pub async fn handle_builtin_command(
    command: &SlashCommand,
    ctx: &CommandContext,
    channel_type: &str,
    chat_id: &str,
) -> Option<String> {
    match command.name.as_str() {
        "help" | "start" => Some(handle_help()),
        "new" => Some(handle_new(ctx, channel_type, chat_id).await),
        "model" => Some(handle_model(&command.args).await),
        "status" => Some(handle_status(ctx.daemon_port).await),
        "users" => Some(handle_users(ctx, channel_type).await),
        "task" => Some(handle_task(ctx, &command.args, channel_type, chat_id).await),
        "repos" => Some(handle_repos(ctx.daemon_port).await),
        "cost" => Some(handle_cost(ctx.daemon_port).await),
        _ => None,
    }
}

fn handle_help() -> String {
    [
        "<b>Available commands:</b>",
        "",
        "<b>Chat</b>",
        "/new — Start a new conversation",
        "/model — Show or change current model",
        "",
        "<b>Tasks</b>",
        "/task &lt;prompt&gt; — Run a background task",
        "/cost — Show usage and costs",
        "",
        "<b>System</b>",
        "/status — Daemon status",
        "/repos — List configured repos",
        "/users — List authorized users",
        "/help — This message",
    ]
    .join("\n")
}

async fn handle_new(ctx: &CommandContext, channel_type: &str, chat_id: &str) -> String {
    match ctx.session_store.delete_by_channel(channel_type, chat_id).await {
        Ok(true) => {
            info!(channel_type, chat_id, "session reset via /new command");
            "Session reset. Starting fresh.".to_string()
        }
        Ok(false) => "No active session to reset.".to_string(),
        Err(err) => format!("Failed to reset session: {err}"),
    }
}

async fn handle_model(args: &str) -> String {
    let home = dirs_next::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let modelstate_path = home.join(".kraken").join("cache").join("modelstate.json");

    if args.is_empty() {
        // Show current model with cost info
        match std::fs::read_to_string(&modelstate_path) {
            Ok(contents) => match serde_json::from_str::<serde_json::Value>(&contents) {
                Ok(parsed) => {
                    let provider = parsed["current"]["providerId"]
                        .as_str()
                        .unwrap_or("unknown");
                    let model = parsed["current"]["modelId"]
                        .as_str()
                        .unwrap_or("unknown");
                    format!("Current model: <b>{provider}/{model}</b>")
                }
                Err(err) => {
                    warn!(error = %err, "modelstate.json is malformed");
                    "Model state file is corrupted. Use /model <name> to set a new one.".to_string()
                }
            },
            Err(_) => "No model configured. Use /model provider/model to set one.".to_string(),
        }
    } else {
        // Change model
        let (provider, model_id) = if let Some((p, m)) = args.split_once('/') {
            (p.to_string(), format!("{m}"))
        } else {
            ("openrouter".to_string(), args.to_string())
        };

        let new_state = serde_json::json!({
            "current": {
                "modelId": if provider == "openrouter" { args.to_string() } else { model_id.clone() },
                "providerId": provider,
            },
            "favorites": [],
            "recents": [],
        });

        // Ensure cache dir exists
        if let Some(parent) = modelstate_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        match std::fs::write(&modelstate_path, serde_json::to_string_pretty(&new_state).unwrap()) {
            Ok(_) => {
                info!(model = args, "model changed via /model command");
                format!("Model changed to: <b>{args}</b>")
            }
            Err(err) => format!("Failed to update model: {err}"),
        }
    }
}

async fn handle_status(daemon_port: u16) -> String {
    let url = format!("http://127.0.0.1:{daemon_port}/api/status");
    let client = reqwest::Client::new();

    match client
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(response) => {
            if let Ok(body) = response.json::<serde_json::Value>().await {
                let status = body["status"].as_str().unwrap_or("unknown");
                let uptime = body["uptime_seconds"].as_u64().unwrap_or(0);
                let active = body["active_tasks"].as_u64().unwrap_or(0);
                let pending = body["pending_tasks"].as_u64().unwrap_or(0);

                let hours = uptime / 3600;
                let minutes = (uptime % 3600) / 60;

                format!(
                    "<b>Daemon Status</b>\n\
                     Status: {status}\n\
                     Uptime: {hours}h {minutes}m\n\
                     Active tasks: {active}\n\
                     Pending tasks: {pending}"
                )
            } else {
                "Daemon is running but returned unexpected response.".to_string()
            }
        }
        Err(_) => "Daemon is not responding.".to_string(),
    }
}

async fn handle_users(ctx: &CommandContext, channel_type: &str) -> String {
    match ctx.user_store.list_authorized(Some(channel_type)).await {
        Ok(users) if users.is_empty() => "No authorized users.".to_string(),
        Ok(users) => {
            let mut lines = vec!["<b>Authorized users:</b>".to_string()];
            for user in &users {
                let name = user.display_name.as_deref().unwrap_or("—");
                lines.push(format!(
                    "  {} ({}) — {}",
                    name, user.platform_id, user.authorized_by
                ));
            }
            lines.join("\n")
        }
        Err(err) => format!("Failed to list users: {err}"),
    }
}

async fn handle_task(
    ctx: &CommandContext,
    args: &str,
    channel_type: &str,
    chat_id: &str,
) -> String {
    if args.is_empty() {
        return "Usage: /task description of what to do\n\
                Options: --repo=name --agent=build|plan"
            .to_string();
    }

    const VALID_AGENTS: &[&str] = &["build", "plan"];

    // Parse optional flags from args
    let mut repo_name: Option<String> = None;
    let mut agent = "build".to_string();
    let mut prompt_parts = Vec::new();

    for part in args.split_whitespace() {
        if let Some(r) = part.strip_prefix("--repo=") {
            repo_name = Some(r.to_string());
        } else if let Some(a) = part.strip_prefix("--agent=") {
            agent = a.to_string();
        } else {
            prompt_parts.push(part);
        }
    }

    // Validate agent
    if !VALID_AGENTS.contains(&agent.as_str()) {
        return format!(
            "Unknown agent <b>{agent}</b>. Valid agents: {}",
            VALID_AGENTS.join(", ")
        );
    }

    let prompt = prompt_parts.join(" ");
    if prompt.is_empty() {
        return "Task description cannot be empty.".to_string();
    }

    // Resolve workdir from repos config
    let config = DaemonConfig::load(None).unwrap_or_default();

    // Validate repo name if specified
    if let Some(ref name) = repo_name {
        if !config.repos.iter().any(|r| r.name.eq_ignore_ascii_case(name)) {
            let available: Vec<&str> = config.repos.iter().map(|r| r.name.as_str()).collect();
            return if available.is_empty() {
                format!("Repo <b>{name}</b> not found. No repos configured. See /repos")
            } else {
                format!(
                    "Repo <b>{name}</b> not found. Available: {}",
                    available.join(", ")
                )
            };
        }
    }

    let workdir = config.resolve_repo_path(repo_name.as_deref());

    let mut body = serde_json::json!({
        "prompt": prompt,
        "priority": 5,
        "agent": agent,
        "channelType": channel_type,
        "channelChatId": chat_id,
    });

    if let Some(ref dir) = workdir {
        body["workdir"] = serde_json::json!(dir);
    }

    let url = format!("http://127.0.0.1:{}/api/schedule", ctx.daemon_port);
    let client = reqwest::Client::new();

    match client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            if let Ok(result) = response.json::<serde_json::Value>().await {
                let task_id = result["task_id"].as_str().unwrap_or("unknown");
                let short_id = &task_id[..8.min(task_id.len())];
                let repo_info = if let Some(ref name) = repo_name {
                    format!(" in <b>{name}</b>")
                } else if let Some(ref dir) = workdir {
                    let short_dir = dir.rsplit('/').next().unwrap_or(dir);
                    format!(" in <b>{short_dir}</b>")
                } else {
                    String::new()
                };
                info!(task_id, agent = agent, "task created via /task command");
                format!("Task created{repo_info}\nID: <code>{short_id}</code>\nAgent: {agent}")
            } else {
                "Task created but couldn't parse response.".to_string()
            }
        }
        Ok(response) => {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            warn!(status = %status, body = %text, "failed to create task");
            format!("Failed to create task: {status}")
        }
        Err(err) => format!("Failed to reach daemon: {err}"),
    }
}

async fn handle_repos(_daemon_port: u16) -> String {
    let config = DaemonConfig::load(None).unwrap_or_default();

    if config.repos.is_empty() {
        return "No repos configured.\n\
                Add repos in <code>~/.kraken/kraken.jsonc</code>:\n\
                <code>\"repos\": [{ \"name\": \"api\", \"path\": \"~/code/api\", \"default\": true }]</code>"
            .to_string();
    }

    let mut lines = vec!["<b>Configured repos:</b>".to_string()];
    for repo in &config.repos {
        let default_marker = if repo.default { " (default)" } else { "" };
        let resolved = config.resolve_repo_path(Some(&repo.name));
        let exists = resolved
            .as_ref()
            .map(|p| std::path::Path::new(p).exists())
            .unwrap_or(false);
        let status = if exists { "+" } else { "!" };
        lines.push(format!(
            "  {status} <b>{}</b> — <code>{}</code>{}",
            repo.name, repo.path, default_marker
        ));
    }
    if lines.len() > 1 {
        lines.push(String::new());
        lines.push("<code>+</code> = path exists, <code>!</code> = path not found".to_string());
    }
    lines.join("\n")
}

async fn handle_cost(daemon_port: u16) -> String {
    let url = format!("http://127.0.0.1:{daemon_port}/api/stats?period=today");
    let client = reqwest::Client::new();

    match client
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            if let Ok(body) = response.json::<serde_json::Value>().await {
                let tasks_completed = body["tasks_completed"].as_u64().unwrap_or(0);
                let tasks_failed = body["tasks_failed"].as_u64().unwrap_or(0);
                let prompt_tokens = body["total_prompt_tokens"].as_u64().unwrap_or(0);
                let completion_tokens = body["total_completion_tokens"].as_u64().unwrap_or(0);
                let total_cost = body["total_estimated_cost_usd"].as_f64().unwrap_or(0.0);

                format!(
                    "<b>Usage today</b>\n\
                     Tasks: {} completed, {} failed\n\
                     Tokens: {} in / {} out\n\
                     Cost: ${:.4}",
                    tasks_completed,
                    tasks_failed,
                    format_tokens(prompt_tokens),
                    format_tokens(completion_tokens),
                    total_cost,
                )
            } else {
                "Stats unavailable.".to_string()
            }
        }
        _ => "Daemon is not responding.".to_string(),
    }
}

fn format_tokens(count: u64) -> String {
    if count >= 1_000_000 {
        format!("{:.1}M", count as f64 / 1_000_000.0)
    } else if count >= 1_000 {
        format!("{:.1}K", count as f64 / 1_000.0)
    } else {
        count.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_command() {
        let cmd = parse_slash_command("/help").unwrap();
        assert_eq!(cmd.name, "help");
        assert_eq!(cmd.args, "");
    }

    #[test]
    fn parse_command_with_args() {
        let cmd = parse_slash_command("/model qwen/qwen3-235b").unwrap();
        assert_eq!(cmd.name, "model");
        assert_eq!(cmd.args, "qwen/qwen3-235b");
    }

    #[test]
    fn parse_command_with_bot_suffix() {
        let cmd = parse_slash_command("/help@MyKrakenBot").unwrap();
        assert_eq!(cmd.name, "help");
        assert_eq!(cmd.args, "");
    }

    #[test]
    fn parse_not_a_command() {
        assert!(parse_slash_command("hello world").is_none());
        assert!(parse_slash_command("").is_none());
        assert!(parse_slash_command("/").is_none());
    }

    #[test]
    fn parse_command_case_insensitive() {
        let cmd = parse_slash_command("/MODEL qwen").unwrap();
        assert_eq!(cmd.name, "model");
    }

    #[test]
    fn parse_command_with_extra_whitespace() {
        let cmd = parse_slash_command("  /model   some/model  ").unwrap();
        assert_eq!(cmd.name, "model");
        assert_eq!(cmd.args, "some/model");
    }
}
