use std::path::PathBuf;

use console::style;
use dialoguer::{Confirm, Input, Password, Select};

use crate::cli::env_helpers::save_secret_to_env_file;
use crate::daemon::config::{
    CronTriggerFileConfig, DaemonConfig, LanguageModelConfig, NotificationChannelFileConfig,
    NotificationsFileConfig, TriggersFileConfig, WatcherTriggerFileConfig,
};

const LLM_PROVIDER_OPTIONS: &[&str] = &["OpenRouter", "Anthropic", "OpenAI"];
const NOTIFICATION_PROVIDER_OPTIONS: &[&str] = &["Slack", "Discord"];

fn map_provider_display_name_to_config_string(provider_display_name: &str) -> &'static str {
    match provider_display_name {
        "OpenRouter" => "openrouter",
        "Anthropic" => "anthropic",
        "OpenAI" => "openai",
        _ => "openrouter",
    }
}

fn map_provider_display_name_to_env_var(provider_display_name: &str) -> Option<&'static str> {
    match provider_display_name {
        "OpenRouter" => Some("OPENROUTER_API_KEY"),
        "Anthropic" => Some("ANTHROPIC_API_KEY"),
        "OpenAI" => Some("OPENAI_API_KEY"),
        _ => None,
    }
}

fn map_notification_provider_to_config_string(notification_provider: &str) -> &'static str {
    match notification_provider {
        "Slack" => "slack",
        "Discord" => "discord",
        _ => "slack",
    }
}

fn run_interactive_wizard() -> Result<DaemonConfig, Box<dyn std::error::Error>> {
    let kraken_config_path = resolve_global_config_path();

    if kraken_config_path.exists() {
        println!(
            "{} {} already exists.",
            style("Warning:").yellow().bold(),
            style(kraken_config_path.display()).cyan()
        );
        let user_confirmed_overwrite = Confirm::new()
            .with_prompt("Overwrite existing config?")
            .default(false)
            .interact()?;

        if !user_confirmed_overwrite {
            println!("{}", style("Aborted.").red());
            std::process::exit(0);
        }
    }

    println!();
    println!("{}", style("LLM Provider").bold().underlined());
    let selected_provider_index = Select::new()
        .with_prompt("Select your LLM provider")
        .items(LLM_PROVIDER_OPTIONS)
        .default(0)
        .interact()?;

    let selected_provider_display_name = LLM_PROVIDER_OPTIONS[selected_provider_index];
    let selected_provider_config_string =
        map_provider_display_name_to_config_string(selected_provider_display_name);

    if let Some(env_variable_name) =
        map_provider_display_name_to_env_var(selected_provider_display_name)
    {
        println!();
        println!("{}", style("API Key").bold().underlined());
        let entered_api_key: String = Password::new()
            .with_prompt(format!(
                "Enter your {} (will be saved to ~/.kraken/.env)",
                env_variable_name
            ))
            .interact()?;

        if !entered_api_key.is_empty() {
            save_secret_to_env_file(env_variable_name, &entered_api_key)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            println!(
                "{} Saved {} to {}",
                style("✓").green().bold(),
                style(env_variable_name).cyan(),
                style("~/.kraken/.env").cyan()
            );
        }
    }

    println!();
    println!("{}", style("Triggers").bold().underlined());
    let user_wants_cron_trigger = Confirm::new()
        .with_prompt("Add a default daily lint cron trigger?")
        .default(false)
        .interact()?;

    let mut cron_trigger_list: Vec<CronTriggerFileConfig> = Vec::new();
    if user_wants_cron_trigger {
        cron_trigger_list.push(CronTriggerFileConfig {
            name: "daily-lint".to_string(),
            expression: "0 0 9 * * *".to_string(),
            task: "Run linter and fix any warnings".to_string(),
            branch_prefix: Some("kraken/lint".to_string()),
            model: None,
            agent: None,
        });
        println!(
            "{} Added daily lint cron (runs at 09:00 every day).",
            style("✓").green().bold()
        );
    }

    let user_wants_file_watcher = Confirm::new()
        .with_prompt("Add a file watcher trigger?")
        .default(false)
        .interact()?;

    let mut watcher_trigger_list: Vec<WatcherTriggerFileConfig> = Vec::new();
    if user_wants_file_watcher {
        let watched_path: String = Input::new()
            .with_prompt("Watch path")
            .default("src/".to_string())
            .interact_text()?;

        watcher_trigger_list.push(WatcherTriggerFileConfig {
            name: "src-watcher".to_string(),
            paths: vec![watched_path.clone()],
            ignore: vec!["node_modules".to_string(), ".git".to_string()],
            debounce_ms: 500,
            task: "Review and fix any issues in the changed files".to_string(),
        });
        println!(
            "{} Added file watcher for {}",
            style("✓").green().bold(),
            style(&watched_path).cyan()
        );
    }

    println!();
    println!("{}", style("Notifications").bold().underlined());
    let user_wants_notifications = Confirm::new()
        .with_prompt("Configure a notification channel?")
        .default(false)
        .interact()?;

    let mut notification_channel_list: Vec<NotificationChannelFileConfig> = Vec::new();
    if user_wants_notifications {
        let selected_notification_provider_index = Select::new()
            .with_prompt("Select notification provider")
            .items(NOTIFICATION_PROVIDER_OPTIONS)
            .default(0)
            .interact()?;

        let selected_notification_provider_display =
            NOTIFICATION_PROVIDER_OPTIONS[selected_notification_provider_index];
        let selected_notification_provider_config =
            map_notification_provider_to_config_string(selected_notification_provider_display);

        let entered_webhook_url: String = Input::new()
            .with_prompt(format!(
                "Enter {} webhook URL",
                selected_notification_provider_display
            ))
            .interact_text()?;

        notification_channel_list.push(NotificationChannelFileConfig {
            name: selected_notification_provider_config.to_string(),
            provider: selected_notification_provider_config.to_string(),
            webhook_url: Some(entered_webhook_url),
            api_key: None,
            token: None,
            repo: None,
            from: None,
            to: None,
            events: vec!["task.completed".to_string(), "task.failed".to_string()],
        });
        println!(
            "{} Added {} notification channel.",
            style("✓").green().bold(),
            style(selected_notification_provider_display).cyan()
        );
    }

    let daemon_configuration = DaemonConfig {
        database_path: "~/.kraken/data/kraken.db".to_string(),
        orchestrator: Default::default(),
        services: Default::default(),
        git: Default::default(),
        triggers: TriggersFileConfig {
            crons: cron_trigger_list,
            webhooks: vec![],
            watchers: watcher_trigger_list,
            ci_failures: vec![],
            pr_mentions: vec![],
            slash_commands: vec![],
        },
        notifications: NotificationsFileConfig {
            channels: notification_channel_list,
        },
        costs: Default::default(),
        language_model: LanguageModelConfig {
            provider: selected_provider_config_string.to_string(),
            ..Default::default()
        },
        mcp: Default::default(),
        audit: Default::default(),
        rate_limits: Default::default(),
        channels: Default::default(),
        repos: vec![],
        widget: Default::default(),
    };

    Ok(daemon_configuration)
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

fn print_init_summary(daemon_configuration: &DaemonConfig, used_defaults: bool) {
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
        style(&daemon_configuration.language_model.provider).cyan()
    );
    println!(
        "  {} {}",
        style("Model:").bold(),
        style(&daemon_configuration.language_model.model).cyan()
    );

    let cron_count = daemon_configuration.triggers.crons.len();
    let watcher_count = daemon_configuration.triggers.watchers.len();
    let notification_count = daemon_configuration.notifications.channels.len();

    println!(
        "  {} {} cron(s), {} watcher(s)",
        style("Triggers:").bold(),
        cron_count,
        watcher_count
    );
    println!(
        "  {} {} channel(s)",
        style("Notifications:").bold(),
        notification_count
    );

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
