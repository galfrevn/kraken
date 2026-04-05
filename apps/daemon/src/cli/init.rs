use std::collections::HashMap;
use std::path::PathBuf;

use console::style;
use dialoguer::{Confirm, Input, Password, Select};

use crate::cli::env_helpers::save_secret_to_env_file;
use crate::daemon::config::{
    ChannelsConfig, CiFailureTriggerFileConfig, CronTriggerFileConfig, DaemonConfig,
    DiscordChannelConfig, DmPolicy, GitHubConfig, LanguageModelConfig, McpServerConfig,
    NotificationChannelFileConfig, NotificationsFileConfig, PrMentionTriggerFileConfig, RepoConfig,
    TelegramChannelConfig, TriggersFileConfig, WatcherTriggerFileConfig,
    WebhookEventFileConfig, WebhookTriggerFileConfig,
};

const LLM_PROVIDER_OPTIONS: &[&str] = &["OpenRouter", "Copilot"];
const TRIGGER_TYPE_OPTIONS: &[&str] = &[
    "Cron (scheduled)",
    "File Watcher",
    "Webhook (GitHub/GitLab)",
    "CI Failure Monitor",
    "PR Mention",
];
const NOTIFICATION_PROVIDER_OPTIONS: &[&str] =
    &["Slack", "Discord", "Email (Resend)", "GitHub", "System (OS notifications)"];
const CHANNEL_OPTIONS: &[&str] = &["Telegram", "Discord"];
const DM_POLICY_OPTIONS: &[&str] = &["Pairing (code-based access)", "Allowlist (specific IDs)"];
const MCP_TYPE_OPTIONS: &[&str] = &["Local (command)", "Remote (URL)"];

// ── Helpers ─────────────────────────────────────────────────────────────

fn section_header(title: &str) {
    println!();
    println!("{}", style(title).bold().underlined());
}

fn success(message: &str) {
    println!("{} {message}", style("✓").green().bold());
}

fn parse_comma_list(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn save_secret(name: &str, value: &str) -> Result<(), Box<dyn std::error::Error>> {
    save_secret_to_env_file(name, value).map_err(|e| -> Box<dyn std::error::Error> { e.into() })
}

// ── Section: LLM Provider ───────────────────────────────────────────────

fn section_llm_provider() -> Result<LanguageModelConfig, Box<dyn std::error::Error>> {
    section_header("LLM Provider");

    let provider_index = Select::new()
        .with_prompt("Select your LLM provider")
        .items(LLM_PROVIDER_OPTIONS)
        .default(0)
        .interact()?;

    let provider_display = LLM_PROVIDER_OPTIONS[provider_index];
    let provider_config = match provider_display {
        "Copilot" => "copilot",
        _ => "openrouter",
    };

    if provider_display == "OpenRouter" {
        println!();
        let api_key: String = Password::new()
            .with_prompt("Enter your OPENROUTER_API_KEY (saved to ~/.kraken/.env)")
            .interact()?;

        if !api_key.is_empty() {
            save_secret("OPENROUTER_API_KEY", &api_key)?;
            success(&format!(
                "Saved {} to {}",
                style("OPENROUTER_API_KEY").cyan(),
                style("~/.kraken/.env").cyan()
            ));
        }
    }

    Ok(LanguageModelConfig {
        provider: provider_config.to_string(),
        ..Default::default()
    })
}

// ── Section: GitHub ─────────────────────────────────────────────────────

fn section_github() -> Result<GitHubConfig, Box<dyn std::error::Error>> {
    section_header("GitHub");

    let wants = Confirm::new()
        .with_prompt("Configure GitHub integration?")
        .default(false)
        .interact()?;

    if !wants {
        return Ok(Default::default());
    }

    let token: String = Password::new()
        .with_prompt("GitHub personal access token (saved to ~/.kraken/.env)")
        .interact()?;

    if !token.is_empty() {
        save_secret("GITHUB_TOKEN", &token)?;
        success("Saved GITHUB_TOKEN");
    }

    let default_repo: String = Input::new()
        .with_prompt("Default repository (owner/repo, blank to skip)")
        .default(String::new())
        .interact_text()?;

    Ok(GitHubConfig {
        token: Some("${GITHUB_TOKEN}".to_string()),
        default_repo: if default_repo.is_empty() {
            None
        } else {
            Some(default_repo)
        },
    })
}

// ── Section: Triggers ───────────────────────────────────────────────────

fn prompt_cron_trigger() -> Result<CronTriggerFileConfig, Box<dyn std::error::Error>> {
    let name: String = Input::new()
        .with_prompt("Trigger name")
        .default("daily-review".to_string())
        .interact_text()?;

    let expression: String = Input::new()
        .with_prompt("Cron expression (6-field with seconds)")
        .default("0 0 9 * * *".to_string())
        .interact_text()?;

    let task: String = Input::new()
        .with_prompt("Task prompt")
        .interact_text()?;

    success(&format!("Added cron trigger {}", style(&name).cyan()));

    Ok(CronTriggerFileConfig {
        name,
        expression,
        task,
        branch_prefix: None,
        model: None,
        agent: None,
    })
}

fn prompt_watcher_trigger() -> Result<WatcherTriggerFileConfig, Box<dyn std::error::Error>> {
    let name: String = Input::new()
        .with_prompt("Trigger name")
        .default("src-watcher".to_string())
        .interact_text()?;

    let paths_input: String = Input::new()
        .with_prompt("Paths to watch (comma-separated)")
        .default("src/".to_string())
        .interact_text()?;

    let ignore_input: String = Input::new()
        .with_prompt("Ignore patterns (comma-separated)")
        .default("node_modules,.git,dist,target".to_string())
        .interact_text()?;

    let task: String = Input::new()
        .with_prompt("Task prompt")
        .default("Review and fix any issues in the changed files".to_string())
        .interact_text()?;

    success(&format!("Added file watcher {}", style(&name).cyan()));

    Ok(WatcherTriggerFileConfig {
        name,
        paths: parse_comma_list(&paths_input),
        ignore: parse_comma_list(&ignore_input),
        debounce_ms: 500,
        task,
    })
}

fn prompt_webhook_trigger() -> Result<WebhookTriggerFileConfig, Box<dyn std::error::Error>> {
    let name: String = Input::new()
        .with_prompt("Trigger name")
        .default("github-events".to_string())
        .interact_text()?;

    let provider_index = Select::new()
        .with_prompt("Webhook provider")
        .items(&["GitHub", "GitLab"])
        .default(0)
        .interact()?;
    let provider = if provider_index == 0 { "github" } else { "gitlab" };

    let secret: String = Input::new()
        .with_prompt("Webhook secret (use ${ENV_VAR} syntax)")
        .default("${GITHUB_WEBHOOK_SECRET}".to_string())
        .interact_text()?;

    let event_type: String = Input::new()
        .with_prompt("Event type (e.g. push, pull_request, issues.opened)")
        .interact_text()?;

    let task: String = Input::new()
        .with_prompt("Task prompt")
        .interact_text()?;

    success(&format!("Added webhook trigger {}", style(&name).cyan()));

    Ok(WebhookTriggerFileConfig {
        name,
        provider: provider.to_string(),
        secret,
        events: vec![WebhookEventFileConfig {
            event_type,
            filter: vec![],
            task,
        }],
    })
}

fn prompt_ci_failure_trigger() -> Result<CiFailureTriggerFileConfig, Box<dyn std::error::Error>> {
    let name: String = Input::new()
        .with_prompt("Trigger name")
        .default("ci-failure-fix".to_string())
        .interact_text()?;

    let repo: String = Input::new()
        .with_prompt("Repository (owner/repo)")
        .interact_text()?;

    let branches_input: String = Input::new()
        .with_prompt("Branches to monitor (comma-separated, blank for all)")
        .default("main".to_string())
        .interact_text()?;

    let task: String = Input::new()
        .with_prompt("Task prompt")
        .default("Investigate and fix the CI failure".to_string())
        .interact_text()?;

    success(&format!("Added CI failure trigger {}", style(&name).cyan()));

    Ok(CiFailureTriggerFileConfig {
        name,
        repo,
        branches: parse_comma_list(&branches_input),
        task,
        secret: "${GITHUB_WEBHOOK_SECRET}".to_string(),
    })
}

fn prompt_pr_mention_trigger() -> Result<PrMentionTriggerFileConfig, Box<dyn std::error::Error>> {
    let name: String = Input::new()
        .with_prompt("Trigger name")
        .default("pr-mention".to_string())
        .interact_text()?;

    let repo: String = Input::new()
        .with_prompt("Repository (owner/repo)")
        .interact_text()?;

    let mention: String = Input::new()
        .with_prompt("Mention keyword")
        .default("@kraken".to_string())
        .interact_text()?;

    let task: String = Input::new()
        .with_prompt("Task prompt")
        .default("Address the review comment or requested change".to_string())
        .interact_text()?;

    success(&format!("Added PR mention trigger {}", style(&name).cyan()));

    Ok(PrMentionTriggerFileConfig {
        name,
        repo,
        mention,
        task,
        secret: "${GITHUB_WEBHOOK_SECRET}".to_string(),
    })
}

fn section_triggers() -> Result<TriggersFileConfig, Box<dyn std::error::Error>> {
    section_header("Triggers");

    let wants = Confirm::new()
        .with_prompt("Configure triggers?")
        .default(false)
        .interact()?;

    if !wants {
        return Ok(Default::default());
    }

    let mut crons = Vec::new();
    let mut watchers = Vec::new();
    let mut webhooks = Vec::new();
    let mut ci_failures = Vec::new();
    let mut pr_mentions = Vec::new();

    loop {
        let type_index = Select::new()
            .with_prompt("Trigger type")
            .items(TRIGGER_TYPE_OPTIONS)
            .default(0)
            .interact()?;

        match type_index {
            0 => crons.push(prompt_cron_trigger()?),
            1 => watchers.push(prompt_watcher_trigger()?),
            2 => webhooks.push(prompt_webhook_trigger()?),
            3 => ci_failures.push(prompt_ci_failure_trigger()?),
            4 => pr_mentions.push(prompt_pr_mention_trigger()?),
            _ => {}
        }

        let add_another = Confirm::new()
            .with_prompt("Add another trigger?")
            .default(false)
            .interact()?;

        if !add_another {
            break;
        }
    }

    Ok(TriggersFileConfig {
        crons,
        watchers,
        webhooks,
        ci_failures,
        pr_mentions,
        slash_commands: vec![],
    })
}

// ── Section: Notifications ──────────────────────────────────────────────

fn section_notifications() -> Result<NotificationsFileConfig, Box<dyn std::error::Error>> {
    section_header("Notifications");

    let wants = Confirm::new()
        .with_prompt("Configure notification channels?")
        .default(false)
        .interact()?;

    if !wants {
        return Ok(Default::default());
    }

    let mut channels = Vec::new();

    loop {
        let provider_index = Select::new()
            .with_prompt("Notification provider")
            .items(NOTIFICATION_PROVIDER_OPTIONS)
            .default(0)
            .interact()?;

        let events_input: String = Input::new()
            .with_prompt("Events (comma-separated: task.completed, task.failed, pr.created, daily_digest, cost.warning)")
            .default("task.completed,task.failed".to_string())
            .interact_text()?;
        let events = parse_comma_list(&events_input);

        let channel = match provider_index {
            0 => {
                // Slack
                let url: String = Input::new()
                    .with_prompt("Slack webhook URL")
                    .interact_text()?;
                NotificationChannelFileConfig {
                    name: "slack".to_string(),
                    provider: "slack".to_string(),
                    webhook_url: Some(url),
                    api_key: None, token: None, repo: None, from: None, to: None,
                    events,
                }
            }
            1 => {
                // Discord
                let url: String = Input::new()
                    .with_prompt("Discord webhook URL")
                    .interact_text()?;
                NotificationChannelFileConfig {
                    name: "discord".to_string(),
                    provider: "discord".to_string(),
                    webhook_url: Some(url),
                    api_key: None, token: None, repo: None, from: None, to: None,
                    events,
                }
            }
            2 => {
                // Email
                let api_key: String = Password::new()
                    .with_prompt("Resend API key (saved to ~/.kraken/.env)")
                    .interact()?;
                if !api_key.is_empty() {
                    save_secret("RESEND_API_KEY", &api_key)?;
                }
                let from: String = Input::new().with_prompt("From address").interact_text()?;
                let to: String = Input::new().with_prompt("To address").interact_text()?;
                NotificationChannelFileConfig {
                    name: "email".to_string(),
                    provider: "email".to_string(),
                    api_key: Some("${RESEND_API_KEY}".to_string()),
                    from: Some(from),
                    to: Some(to),
                    webhook_url: None, token: None, repo: None,
                    events,
                }
            }
            3 => {
                // GitHub
                let repo: String = Input::new()
                    .with_prompt("Repository (owner/repo)")
                    .interact_text()?;
                NotificationChannelFileConfig {
                    name: "github".to_string(),
                    provider: "github".to_string(),
                    token: Some("${GITHUB_TOKEN}".to_string()),
                    repo: Some(repo),
                    webhook_url: None, api_key: None, from: None, to: None,
                    events,
                }
            }
            4 => {
                // System
                NotificationChannelFileConfig {
                    name: "system".to_string(),
                    provider: "system".to_string(),
                    webhook_url: None, api_key: None, token: None, repo: None, from: None, to: None,
                    events,
                }
            }
            _ => continue,
        };

        success(&format!(
            "Added {} notification channel",
            style(&channel.provider).cyan()
        ));
        channels.push(channel);

        let add_another = Confirm::new()
            .with_prompt("Add another notification channel?")
            .default(false)
            .interact()?;

        if !add_another {
            break;
        }
    }

    Ok(NotificationsFileConfig { channels })
}

// ── Section: Chat Channels ──────────────────────────────────────────────

fn section_channels() -> Result<ChannelsConfig, Box<dyn std::error::Error>> {
    section_header("Chat Channels");

    let wants = Confirm::new()
        .with_prompt("Configure a chat channel (Telegram/Discord bot)?")
        .default(false)
        .interact()?;

    if !wants {
        return Ok(Default::default());
    }

    let mut telegram: Option<TelegramChannelConfig> = None;
    let mut discord: Option<DiscordChannelConfig> = None;

    loop {
        let channel_index = Select::new()
            .with_prompt("Channel platform")
            .items(CHANNEL_OPTIONS)
            .default(0)
            .interact()?;

        match channel_index {
            0 => {
                // Telegram
                let token: String = Password::new()
                    .with_prompt("Telegram bot token (saved to ~/.kraken/.env)")
                    .interact()?;
                if !token.is_empty() {
                    save_secret("TELEGRAM_BOT_TOKEN", &token)?;
                }

                let policy_index = Select::new()
                    .with_prompt("DM policy")
                    .items(DM_POLICY_OPTIONS)
                    .default(0)
                    .interact()?;

                let mut allow_from = Vec::new();
                let dm_policy = if policy_index == 1 {
                    let ids_input: String = Input::new()
                        .with_prompt("Allowed Telegram user IDs (comma-separated)")
                        .interact_text()?;
                    allow_from = parse_comma_list(&ids_input)
                        .iter()
                        .filter_map(|s| s.parse::<i64>().ok())
                        .collect();
                    DmPolicy::Allowlist
                } else {
                    DmPolicy::Pairing
                };

                telegram = Some(TelegramChannelConfig {
                    token: "${TELEGRAM_BOT_TOKEN}".to_string(),
                    dm_policy,
                    allow_from,
                    enabled: true,
                    owner_id: None,
                });
                success("Added Telegram channel");
            }
            1 => {
                // Discord
                let token: String = Password::new()
                    .with_prompt("Discord bot token (saved to ~/.kraken/.env)")
                    .interact()?;
                if !token.is_empty() {
                    save_secret("DISCORD_BOT_TOKEN", &token)?;
                }

                let policy_index = Select::new()
                    .with_prompt("DM policy")
                    .items(DM_POLICY_OPTIONS)
                    .default(0)
                    .interact()?;

                let mut allow_from = Vec::new();
                let dm_policy = if policy_index == 1 {
                    let ids_input: String = Input::new()
                        .with_prompt("Allowed Discord user IDs (comma-separated)")
                        .interact_text()?;
                    allow_from = parse_comma_list(&ids_input)
                        .iter()
                        .filter_map(|s| s.parse::<u64>().ok())
                        .collect();
                    DmPolicy::Allowlist
                } else {
                    DmPolicy::Pairing
                };

                let channels_input: String = Input::new()
                    .with_prompt("Allowed channel IDs (comma-separated, blank for all)")
                    .default(String::new())
                    .interact_text()?;
                let allowed_channels: Vec<u64> = parse_comma_list(&channels_input)
                    .iter()
                    .filter_map(|s| s.parse::<u64>().ok())
                    .collect();

                discord = Some(DiscordChannelConfig {
                    token: "${DISCORD_BOT_TOKEN}".to_string(),
                    dm_policy,
                    allow_from,
                    allowed_channels,
                    enabled: true,
                });
                success("Added Discord channel");
            }
            _ => {}
        }

        // Only allow adding a second channel if one slot is still empty
        if telegram.is_some() && discord.is_some() {
            break;
        }

        let add_another = Confirm::new()
            .with_prompt("Add another chat channel?")
            .default(false)
            .interact()?;

        if !add_another {
            break;
        }
    }

    Ok(ChannelsConfig {
        telegram,
        discord,
        worker_port: 7900,
    })
}

// ── Section: Repositories ───────────────────────────────────────────────

fn section_repos() -> Result<Vec<RepoConfig>, Box<dyn std::error::Error>> {
    section_header("Repositories");

    let wants = Confirm::new()
        .with_prompt("Configure project repositories?")
        .default(false)
        .interact()?;

    if !wants {
        return Ok(vec![]);
    }

    let mut repos: Vec<RepoConfig> = Vec::new();

    loop {
        let name: String = Input::new()
            .with_prompt("Repository name")
            .interact_text()?;

        let default_path = format!("~/projects/{name}");
        let path: String = Input::new()
            .with_prompt("Local path")
            .default(default_path)
            .interact_text()?;

        let is_default = if repos.is_empty() {
            true
        } else {
            Confirm::new()
                .with_prompt("Set as default repository?")
                .default(false)
                .interact()?
        };

        success(&format!("Added repo {}", style(&name).cyan()));

        // If new repo is default, clear previous default
        if is_default {
            for repo in &mut repos {
                repo.default = false;
            }
        }

        repos.push(RepoConfig {
            name,
            path,
            default: is_default,
        });

        let add_another = Confirm::new()
            .with_prompt("Add another repository?")
            .default(false)
            .interact()?;

        if !add_another {
            break;
        }
    }

    Ok(repos)
}

// ── Section: MCP Servers ────────────────────────────────────────────────

fn section_mcp() -> Result<HashMap<String, McpServerConfig>, Box<dyn std::error::Error>> {
    section_header("MCP Servers");

    let wants = Confirm::new()
        .with_prompt("Configure MCP tool servers?")
        .default(false)
        .interact()?;

    if !wants {
        return Ok(HashMap::new());
    }

    let mut servers = HashMap::new();

    loop {
        let name: String = Input::new()
            .with_prompt("Server name")
            .interact_text()?;

        let type_index = Select::new()
            .with_prompt("Server type")
            .items(MCP_TYPE_OPTIONS)
            .default(0)
            .interact()?;

        let config = if type_index == 0 {
            let command_input: String = Input::new()
                .with_prompt("Command (e.g. npx -y @modelcontextprotocol/server-filesystem /path)")
                .interact_text()?;
            let command: Vec<String> = command_input
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();

            McpServerConfig::Local {
                command,
                environment: HashMap::new(),
                enabled: true,
                timeout: None,
            }
        } else {
            let url: String = Input::new()
                .with_prompt("Server URL")
                .interact_text()?;

            McpServerConfig::Remote {
                url,
                headers: HashMap::new(),
                enabled: true,
                timeout: None,
            }
        };

        success(&format!("Added MCP server {}", style(&name).cyan()));
        servers.insert(name, config);

        let add_another = Confirm::new()
            .with_prompt("Add another MCP server?")
            .default(false)
            .interact()?;

        if !add_another {
            break;
        }
    }

    Ok(servers)
}

// ── Wizard ──────────────────────────────────────────────────────────────

fn run_interactive_wizard() -> Result<DaemonConfig, Box<dyn std::error::Error>> {
    let kraken_config_path = resolve_global_config_path();

    if kraken_config_path.exists() {
        println!(
            "{} {} already exists.",
            style("Warning:").yellow().bold(),
            style(kraken_config_path.display()).cyan()
        );
        let overwrite = Confirm::new()
            .with_prompt("Overwrite existing config?")
            .default(false)
            .interact()?;

        if !overwrite {
            println!("{}", style("Aborted.").red());
            std::process::exit(0);
        }
    }

    let language_model = section_llm_provider()?;
    let github = section_github()?;
    let triggers = section_triggers()?;
    let notifications = section_notifications()?;
    let channels = section_channels()?;
    let repos = section_repos()?;
    let mcp = section_mcp()?;

    Ok(DaemonConfig {
        database_path: "~/.kraken/data/kraken.db".to_string(),
        orchestrator: Default::default(),
        services: Default::default(),
        git: Default::default(),
        triggers,
        notifications,
        costs: Default::default(),
        language_model,
        mcp,
        audit: Default::default(),
        rate_limits: Default::default(),
        channels,
        repos,
        github,
        widget: Default::default(),
    })
}

fn build_defaults_config() -> DaemonConfig {
    DaemonConfig {
        database_path: "~/.kraken/data/kraken.db".to_string(),
        orchestrator: Default::default(),
        services: Default::default(),
        git: Default::default(),
        triggers: TriggersFileConfig::default(),
        notifications: NotificationsFileConfig::default(),
        costs: Default::default(),
        language_model: LanguageModelConfig {
            provider: "openrouter".to_string(),
            ..Default::default()
        },
        mcp: Default::default(),
        audit: Default::default(),
        rate_limits: Default::default(),
        channels: Default::default(),
        repos: vec![],
        github: Default::default(),
        widget: Default::default(),
    }
}

fn resolve_global_config_path() -> PathBuf {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".kraken").join("kraken.jsonc")
}

fn write_daemon_config_to_jsonc(
    daemon_configuration: &DaemonConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let config_path = resolve_global_config_path();
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json_string = daemon_configuration
        .to_json_pretty()
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
    std::fs::write(&config_path, &json_string)?;
    Ok(())
}

fn print_init_summary(config: &DaemonConfig, used_defaults: bool) {
    println!();
    println!("{}", style("─".repeat(50)).dim());
    println!(
        "{}",
        style("Kraken initialized successfully!").green().bold()
    );
    println!("{}", style("─".repeat(50)).dim());
    println!();

    println!(
        "  {} {}",
        style("Config file:").bold(),
        style("~/.kraken/kraken.jsonc").cyan()
    );
    println!(
        "  {} {}",
        style("LLM provider:").bold(),
        style(&config.language_model.provider).cyan()
    );

    if config.github.token.is_some() {
        let repo_display = config
            .github
            .default_repo
            .as_deref()
            .unwrap_or("(no default repo)");
        println!(
            "  {} configured ({})",
            style("GitHub:").bold(),
            style(repo_display).cyan()
        );
    }

    let cron_count = config.triggers.crons.len();
    let watcher_count = config.triggers.watchers.len();
    let webhook_count = config.triggers.webhooks.len();
    let ci_count = config.triggers.ci_failures.len();
    let pr_count = config.triggers.pr_mentions.len();
    let trigger_total = cron_count + watcher_count + webhook_count + ci_count + pr_count;

    if trigger_total > 0 {
        let mut parts = Vec::new();
        if cron_count > 0 {
            parts.push(format!("{cron_count} cron"));
        }
        if watcher_count > 0 {
            parts.push(format!("{watcher_count} watcher"));
        }
        if webhook_count > 0 {
            parts.push(format!("{webhook_count} webhook"));
        }
        if ci_count > 0 {
            parts.push(format!("{ci_count} ci-failure"));
        }
        if pr_count > 0 {
            parts.push(format!("{pr_count} pr-mention"));
        }
        println!(
            "  {} {}",
            style("Triggers:").bold(),
            parts.join(", ")
        );
    }

    let notification_count = config.notifications.channels.len();
    if notification_count > 0 {
        println!(
            "  {} {} channel(s)",
            style("Notifications:").bold(),
            notification_count
        );
    }

    let mut chat_parts = Vec::new();
    if config.channels.telegram.is_some() {
        chat_parts.push("telegram");
    }
    if config.channels.discord.is_some() {
        chat_parts.push("discord");
    }
    if !chat_parts.is_empty() {
        println!(
            "  {} {}",
            style("Chat channels:").bold(),
            style(chat_parts.join(", ")).cyan()
        );
    }

    if !config.repos.is_empty() {
        println!(
            "  {} {} repo(s)",
            style("Repos:").bold(),
            config.repos.len()
        );
    }

    if !config.mcp.is_empty() {
        println!(
            "  {} {} server(s)",
            style("MCP servers:").bold(),
            config.mcp.len()
        );
    }

    if used_defaults {
        println!();
        println!(
            "  {} Run {} to customize further.",
            style("Tip:").blue().bold(),
            style("kraken config set").cyan()
        );
    }

    println!();
    println!(
        "  Run {} to start the daemon.",
        style("kraken start").cyan().bold()
    );
    println!();
}

pub async fn execute(defaults: bool, _json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    println!();
    println!("{}", style("Kraken Init Wizard").bold().cyan());
    println!("{}", style("Setting up your Kraken configuration...").dim());
    println!();

    let daemon_configuration = if defaults {
        println!(
            "{} Using default configuration (--defaults flag detected).",
            style("Info:").blue().bold()
        );
        build_defaults_config()
    } else {
        run_interactive_wizard()?
    };

    write_daemon_config_to_jsonc(&daemon_configuration)?;

    print_init_summary(&daemon_configuration, defaults);

    Ok(())
}
