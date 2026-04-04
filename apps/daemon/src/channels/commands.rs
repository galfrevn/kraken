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
        "tasks" => Some(handle_tasks(ctx.daemon_port).await),
        "agent" => Some(handle_agent(ctx, &command.args, channel_type, chat_id).await),
        "repos" => Some(handle_repos(ctx.daemon_port).await),
        "cost" => Some(handle_cost(ctx.daemon_port).await),
        "read" => Some(handle_read(&command.args).await),
        "grep" => Some(handle_grep(&command.args).await),
        "git" => Some(handle_git(&command.args).await),
        "pr" => Some(handle_pr(ctx.daemon_port, &command.args).await),
        "issues" => Some(handle_issues(ctx.daemon_port, &command.args).await),
        _ => None,
    }
}

fn handle_help() -> String {
    [
        "<b>Available commands:</b>",
        "",
        "<b>Chat</b>",
        "/new — Start a new conversation",
        "/model — Show or change model",
        "/agent — Switch agent (build/plan)",
        "",
        "<b>Tasks</b>",
        "/task &lt;prompt&gt; — Run a background task",
        "/tasks — List recent tasks",
        "/cost — Usage and costs",
        "",
        "<b>Code</b>",
        "/read &lt;file&gt; — Show file contents",
        "/grep &lt;pattern&gt; [path] — Search code",
        "/git — Branch, status, recent commits",
        "/pr — List open PRs",
        "/pr &lt;number&gt; — PR details",
        "/issues — List open issues",
        "",
        "<b>System</b>",
        "/status — Daemon status",
        "/repos — Configured repos",
        "/users — Authorized users",
        "/help — This message",
    ]
    .join("\n")
}

async fn handle_new(ctx: &CommandContext, channel_type: &str, chat_id: &str) -> String {
    match ctx
        .session_store
        .delete_by_channel(channel_type, chat_id)
        .await
    {
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
                    let model = parsed["current"]["modelId"].as_str().unwrap_or("unknown");
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
            (p.to_string(), m.to_string())
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

        match std::fs::write(
            &modelstate_path,
            serde_json::to_string_pretty(&new_state).unwrap(),
        ) {
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

const VALID_AGENTS: &[&str] = &["build", "plan"];

async fn handle_agent(
    ctx: &CommandContext,
    args: &str,
    channel_type: &str,
    chat_id: &str,
) -> String {
    if args.is_empty() {
        // Show current agent
        let session = ctx
            .session_store
            .get_or_create_session(channel_type, chat_id)
            .await;
        let current = session
            .ok()
            .and_then(|s| s.metadata)
            .and_then(|m| serde_json::from_str::<serde_json::Value>(&m).ok())
            .and_then(|v| v["agent"].as_str().map(String::from))
            .unwrap_or_else(|| "build".to_string());

        return format!(
            "Current agent: <b>{current}</b>\nAvailable: {}",
            VALID_AGENTS.join(", ")
        );
    }

    let agent = args.trim().to_lowercase();
    if !VALID_AGENTS.contains(&agent.as_str()) {
        return format!(
            "Unknown agent <b>{agent}</b>. Available: {}",
            VALID_AGENTS.join(", ")
        );
    }

    let metadata = serde_json::json!({ "agent": agent }).to_string();
    if let Err(err) = ctx
        .session_store
        .update_metadata(channel_type, chat_id, &metadata)
        .await
    {
        return format!("Failed to update agent: {err}");
    }

    info!(agent = agent, "agent changed via /agent command");
    format!("Agent changed to: <b>{agent}</b>")
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
    if let Some(ref name) = repo_name
        && !config
            .repos
            .iter()
            .any(|r| r.name.eq_ignore_ascii_case(name))
    {
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

// ── /tasks — list recent tasks ────────────────────────────────────────

async fn handle_tasks(daemon_port: u16) -> String {
    let url = format!("http://127.0.0.1:{daemon_port}/api/tasks?limit=10");
    let client = reqwest::Client::new();

    match client
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            if let Ok(body) = response.json::<serde_json::Value>().await {
                let tasks = body["tasks"].as_array();
                match tasks {
                    Some(tasks) if tasks.is_empty() => "No tasks.".to_string(),
                    Some(tasks) => {
                        let mut lines = vec!["<b>Recent tasks:</b>".to_string()];
                        for task in tasks.iter().take(10) {
                            let status = task["status"].as_str().unwrap_or("?");
                            let name = task["name"].as_str().unwrap_or("untitled");
                            let id = task["id"].as_str().unwrap_or("");
                            let short_id = &id[..8.min(id.len())];
                            let icon = match status {
                                "completed" => "✓",
                                "failed" => "✗",
                                "running" => "⏳",
                                "pending" => "○",
                                "cancelled" => "⊘",
                                _ => "?",
                            };
                            let truncated_name = if name.len() > 50 {
                                format!("{}...", &name[..47])
                            } else {
                                name.to_string()
                            };
                            lines
                                .push(format!("  {icon} <code>{short_id}</code> {truncated_name}"));
                        }
                        lines.join("\n")
                    }
                    None => "No tasks found.".to_string(),
                }
            } else {
                "Failed to parse tasks.".to_string()
            }
        }
        _ => "Daemon is not responding.".to_string(),
    }
}

// ── /read — show file contents ────────────────────────────────────────

async fn handle_read(args: &str) -> String {
    if args.is_empty() {
        return "Usage: /read path/to/file".to_string();
    }

    let config = DaemonConfig::load(None).unwrap_or_default();
    let file_path = resolve_file_path(&config, args.trim());

    match std::fs::read_to_string(&file_path) {
        Ok(contents) => {
            let truncated = if contents.len() > 3500 {
                format!(
                    "{}...\n\n<i>({} lines total, showing first ~100)</i>",
                    &contents[..3500],
                    contents.lines().count()
                )
            } else {
                contents
            };
            format!("<code>{}</code>", html_escape(&truncated))
        }
        Err(err) => format!("Failed to read {}: {err}", args.trim()),
    }
}

// ── /grep — search code ──────────────────────────────────────────────

async fn handle_grep(args: &str) -> String {
    if args.is_empty() {
        return "Usage: /grep pattern [path]".to_string();
    }

    let config = DaemonConfig::load(None).unwrap_or_default();
    let (pattern, search_path) = match args.split_once(' ') {
        Some((p, path)) => (p.trim(), path.trim()),
        None => (args.trim(), "."),
    };

    let resolved_path = resolve_file_path(&config, search_path);

    let output = std::process::Command::new("rg")
        .args([
            "--max-count",
            "20",
            "--no-heading",
            "--line-number",
            pattern,
        ])
        .arg(&resolved_path)
        .output();

    match output {
        Ok(result) => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            if stdout.is_empty() {
                format!("No matches for <code>{pattern}</code>")
            } else {
                let truncated = if stdout.len() > 3500 {
                    format!("{}...", &stdout[..3500])
                } else {
                    stdout.to_string()
                };
                format!(
                    "<b>grep:</b> <code>{pattern}</code>\n<pre>{}</pre>",
                    html_escape(&truncated)
                )
            }
        }
        Err(_) => "rg (ripgrep) not found. Install it to use /grep.".to_string(),
    }
}

// ── /git — branch, status, commits ───────────────────────────────────

async fn handle_git(args: &str) -> String {
    let config = DaemonConfig::load(None).unwrap_or_default();
    let workdir = config
        .resolve_repo_path(None)
        .unwrap_or_else(|| ".".to_string());

    let subcommand = if args.is_empty() {
        "summary"
    } else {
        args.trim()
    };

    match subcommand {
        "summary" | "s" => git_summary(&workdir),
        "diff" | "d" => git_diff(&workdir),
        "log" | "l" => git_log(&workdir),
        _ => format!("Unknown: /git {subcommand}\nTry: /git, /git diff, /git log"),
    }
}

fn git_summary(workdir: &str) -> String {
    let branch = run_git(workdir, &["branch", "--show-current"]);
    let status = run_git(workdir, &["status", "--short"]);
    let last_commit = run_git(workdir, &["log", "-1", "--format=%h %s (%cr)"]);

    let mut lines = vec![format!("<b>Branch:</b> {}", branch.trim())];

    if let Some(commit) = last_commit.lines().next() {
        lines.push(format!("<b>Last commit:</b> {commit}"));
    }

    let changes: Vec<&str> = status.lines().collect();
    if changes.is_empty() {
        lines.push("Working tree clean.".to_string());
    } else {
        lines.push(format!("<b>Changes:</b> {} file(s)", changes.len()));
        for change in changes.iter().take(15) {
            lines.push(format!("  <code>{change}</code>"));
        }
        if changes.len() > 15 {
            lines.push(format!("  ... +{} more", changes.len() - 15));
        }
    }

    lines.join("\n")
}

fn git_diff(workdir: &str) -> String {
    let diff = run_git(workdir, &["diff", "--stat"]);
    if diff.is_empty() {
        return "No unstaged changes.".to_string();
    }
    let truncated = if diff.len() > 3500 {
        format!("{}...", &diff[..3500])
    } else {
        diff
    };
    format!("<pre>{}</pre>", html_escape(&truncated))
}

fn git_log(workdir: &str) -> String {
    let log = run_git(
        workdir,
        &["log", "--oneline", "--graph", "-15", "--format=%h %s (%cr)"],
    );
    if log.is_empty() {
        return "No commits.".to_string();
    }
    format!("<pre>{}</pre>", html_escape(&log))
}

fn run_git(workdir: &str, args: &[&str]) -> String {
    std::process::Command::new("git")
        .args(args)
        .current_dir(workdir)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

// ── Helpers ──────────────────────────────────────────────────────────

fn resolve_file_path(config: &DaemonConfig, path: &str) -> String {
    if std::path::Path::new(path).is_absolute() {
        return path.to_string();
    }
    if let Some(repo_path) = config.resolve_repo_path(None) {
        format!("{repo_path}/{path}")
    } else {
        path.to_string()
    }
}

// ── /pr — list or show PRs ────────────────────────────────────────────

async fn handle_pr(daemon_port: u16, args: &str) -> String {
    let client = reqwest::Client::new();

    if args.is_empty() {
        // List open PRs
        let url = format!("http://127.0.0.1:{daemon_port}/api/github/pulls?state=open");
        match client
            .get(&url)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    let pulls = body["pulls"].as_array();
                    match pulls {
                        Some(prs) if prs.is_empty() => "No open PRs.".to_string(),
                        Some(prs) => {
                            let mut lines = vec!["<b>Open PRs:</b>".to_string()];
                            for pr in prs.iter().take(15) {
                                let number = pr["number"].as_u64().unwrap_or(0);
                                let title = pr["title"].as_str().unwrap_or("untitled");
                                let author = pr["user"]["login"].as_str().unwrap_or("?");
                                let draft = pr["draft"].as_bool().unwrap_or(false);
                                let draft_tag = if draft { " [draft]" } else { "" };
                                lines.push(format!(
                                    "  <b>#{number}</b> {title} <i>({author})</i>{draft_tag}"
                                ));
                            }
                            lines.join("\n")
                        }
                        None => "Failed to parse PRs.".to_string(),
                    }
                } else {
                    "Failed to parse response.".to_string()
                }
            }
            Ok(response) => {
                let text = response.text().await.unwrap_or_default();
                format!("GitHub error: {text}")
            }
            _ => "GitHub not configured or daemon not responding.".to_string(),
        }
    } else if let Ok(number) = args.trim().parse::<u64>() {
        // Get specific PR
        let url = format!("http://127.0.0.1:{daemon_port}/api/github/pulls/{number}");
        match client
            .get(&url)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                if let Ok(pr) = response.json::<serde_json::Value>().await {
                    let title = pr["title"].as_str().unwrap_or("untitled");
                    let author = pr["user"]["login"].as_str().unwrap_or("?");
                    let state = pr["state"].as_str().unwrap_or("?");
                    let head = pr["head"]["ref"].as_str().unwrap_or("?");
                    let base = pr["base"]["ref"].as_str().unwrap_or("?");
                    let additions = pr["additions"].as_u64().unwrap_or(0);
                    let deletions = pr["deletions"].as_u64().unwrap_or(0);
                    let files = pr["changed_files"].as_u64().unwrap_or(0);
                    let body_text = pr["body"].as_str().unwrap_or("");
                    let body_preview = if body_text.len() > 500 {
                        format!("{}...", &body_text[..500])
                    } else {
                        body_text.to_string()
                    };

                    format!(
                        "<b>PR #{number}: {title}</b>\n\
                         Author: {author}\n\
                         {head} → {base} ({state})\n\
                         +{additions} -{deletions} ({files} files)\n\
                         {body_preview}"
                    )
                } else {
                    "Failed to parse PR.".to_string()
                }
            }
            _ => format!("PR #{number} not found."),
        }
    } else {
        "Usage: /pr or /pr <number>".to_string()
    }
}

// ── /issues — list issues ────────────────────────────────────────────

async fn handle_issues(daemon_port: u16, args: &str) -> String {
    let client = reqwest::Client::new();

    if args.is_empty() || args.trim() == "open" {
        let url = format!("http://127.0.0.1:{daemon_port}/api/github/issues?state=open");
        match client
            .get(&url)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    let issues = body["issues"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter(|i| i.get("pull_request").is_none())
                                .cloned()
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();

                    if issues.is_empty() {
                        return "No open issues.".to_string();
                    }

                    let mut lines = vec!["<b>Open issues:</b>".to_string()];
                    for issue in issues.iter().take(15) {
                        let number = issue["number"].as_u64().unwrap_or(0);
                        let title = issue["title"].as_str().unwrap_or("untitled");
                        let labels: Vec<&str> = issue["labels"]
                            .as_array()
                            .map(|arr| arr.iter().filter_map(|l| l["name"].as_str()).collect())
                            .unwrap_or_default();
                        let label_str = if labels.is_empty() {
                            String::new()
                        } else {
                            format!(" [{}]", labels.join(", "))
                        };
                        lines.push(format!("  <b>#{number}</b> {title}{label_str}"));
                    }
                    lines.join("\n")
                } else {
                    "Failed to parse issues.".to_string()
                }
            }
            _ => "GitHub not configured or daemon not responding.".to_string(),
        }
    } else {
        "Usage: /issues".to_string()
    }
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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
