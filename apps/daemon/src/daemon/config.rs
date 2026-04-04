use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::notifications::discord::DiscordNotificationChannel;
use crate::notifications::dispatcher::NotificationDispatcher;
use crate::notifications::email::EmailNotificationChannel;
use crate::notifications::github::GitHubNotificationChannel;
use crate::notifications::slack::SlackNotificationChannel;
use crate::notifications::system::SystemNotificationChannel;
use crate::notifications::types::NotificationEventType;
use crate::triggers::types::{
    CronTriggerConfig, SlashCommandTriggerConfig, TriggerFilter, WatcherTriggerConfig,
    WebhookEventConfig, WebhookTriggerConfig,
};

/// Top-level daemon configuration, loaded from kraken.jsonc.
/// Field names use serde rename attributes to match the camelCase JSON keys
/// used throughout the Kraken configuration ecosystem.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DaemonConfig {
    #[serde(rename = "databasePath", default = "default_database_path")]
    pub database_path: String,

    #[serde(default)]
    pub orchestrator: OrchestratorConfig,

    #[serde(default)]
    pub services: ServicesConfig,

    #[serde(default)]
    pub git: GitConfig,

    #[serde(default)]
    pub triggers: TriggersFileConfig,

    #[serde(default)]
    pub notifications: NotificationsFileConfig,

    #[serde(default)]
    pub costs: CostsConfig,

    #[serde(rename = "languageModel", default)]
    pub language_model: LanguageModelConfig,

    #[serde(default)]
    pub mcp: HashMap<String, McpServerConfig>,

    #[serde(default)]
    pub audit: AuditConfig,

    #[serde(rename = "rateLimits", default)]
    pub rate_limits: RateLimitsConfig,

    #[serde(default)]
    pub channels: ChannelsConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LanguageModelConfig {
    #[serde(default = "default_llm_provider")]
    pub provider: String,

    #[serde(default = "default_llm_model")]
    pub model: String,

    #[serde(default = "default_llm_temperature")]
    pub temperature: f32,

    #[serde(rename = "maxTokens", default = "default_llm_max_tokens")]
    pub max_tokens: i32,
}

impl Default for LanguageModelConfig {
    fn default() -> Self {
        Self {
            provider: default_llm_provider(),
            model: default_llm_model(),
            temperature: default_llm_temperature(),
            max_tokens: default_llm_max_tokens(),
        }
    }
}

fn default_llm_provider() -> String {
    "openrouter".into()
}
fn default_llm_model() -> String {
    "anthropic/claude-sonnet-4-20250514".into()
}
fn default_llm_temperature() -> f32 {
    0.7
}
fn default_llm_max_tokens() -> i32 {
    16384
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OrchestratorConfig {
    #[serde(
        rename = "maxConcurrentTasks",
        default = "default_max_concurrent_tasks"
    )]
    pub max_concurrent_tasks: u32,

    #[serde(
        rename = "heartbeatTimeoutSeconds",
        default = "default_heartbeat_timeout_seconds"
    )]
    pub heartbeat_timeout_seconds: u64,

    #[serde(default)]
    pub retry: RetryConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RetryConfig {
    #[serde(rename = "maxRetries", default = "default_max_retries")]
    pub max_retries: u32,

    #[serde(rename = "backoffSeconds", default = "default_backoff_seconds")]
    pub backoff_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServicesConfig {
    #[serde(rename = "daemonPort", default = "default_daemon_port")]
    pub daemon_port: u16,

    #[serde(rename = "webhookPort", default = "default_webhook_port")]
    pub webhook_port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GitConfig {
    #[serde(rename = "branchPrefix", default = "default_branch_prefix")]
    pub branch_prefix: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct CostsConfig {
    #[serde(default, rename = "costWarningThresholdUsd")]
    pub cost_warning_threshold_usd: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum McpServerConfig {
    #[serde(rename = "local")]
    Local {
        command: Vec<String>,
        #[serde(default)]
        environment: HashMap<String, String>,
        #[serde(default = "default_mcp_enabled")]
        enabled: bool,
        #[serde(default)]
        timeout: Option<u64>,
    },
    #[serde(rename = "remote")]
    Remote {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        #[serde(default = "default_mcp_enabled")]
        enabled: bool,
        #[serde(default)]
        timeout: Option<u64>,
    },
}

impl McpServerConfig {
    #[allow(dead_code)]
    pub fn is_enabled(&self) -> bool {
        match self {
            McpServerConfig::Local { enabled, .. } => *enabled,
            McpServerConfig::Remote { enabled, .. } => *enabled,
        }
    }
}

fn default_mcp_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TriggersFileConfig {
    #[serde(default)]
    pub crons: Vec<CronTriggerFileConfig>,
    #[serde(default)]
    pub webhooks: Vec<WebhookTriggerFileConfig>,
    #[serde(default)]
    pub watchers: Vec<WatcherTriggerFileConfig>,
    #[serde(default)]
    pub ci_failures: Vec<CiFailureTriggerFileConfig>,
    #[serde(default)]
    pub pr_mentions: Vec<PrMentionTriggerFileConfig>,
    #[serde(default)]
    pub slash_commands: Vec<SlashCommandTriggerFileConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CronTriggerFileConfig {
    pub name: String,
    pub expression: String,
    pub task: String,
    #[serde(default, rename = "branchPrefix")]
    pub branch_prefix: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WebhookTriggerFileConfig {
    pub name: String,
    pub provider: String,
    pub secret: String,
    pub events: Vec<WebhookEventFileConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WebhookEventFileConfig {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub filter: Vec<String>,
    pub task: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WatcherTriggerFileConfig {
    pub name: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub ignore: Vec<String>,
    #[serde(default = "default_debounce_ms", rename = "debounceMs")]
    pub debounce_ms: u32,
    pub task: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CiFailureTriggerFileConfig {
    pub name: String,
    #[allow(dead_code)]
    pub repo: String,
    #[serde(default)]
    pub branches: Vec<String>,
    pub task: String,
    #[serde(default = "default_github_webhook_secret_ref")]
    pub secret: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PrMentionTriggerFileConfig {
    pub name: String,
    #[allow(dead_code)]
    pub repo: String,
    #[serde(default = "default_pr_mention_keyword")]
    pub mention: String,
    pub task: String,
    #[serde(default = "default_github_webhook_secret_ref")]
    pub secret: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SlashCommandTriggerFileConfig {
    pub name: String,
    pub provider: String,
    pub token: String,
    #[serde(default, rename = "appToken")]
    pub app_token: Option<String>,
    pub channel: String,
    pub task: String,
    #[serde(default = "default_slash_command_mention")]
    pub mention: String,
}

fn default_slash_command_mention() -> String {
    "@kraken".to_string()
}

fn default_pr_mention_keyword() -> String {
    "@kraken".to_string()
}

fn default_github_webhook_secret_ref() -> String {
    "${GITHUB_WEBHOOK_SECRET}".to_string()
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct NotificationsFileConfig {
    #[serde(default)]
    pub channels: Vec<NotificationChannelFileConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NotificationChannelFileConfig {
    pub name: String,
    pub provider: String,
    #[serde(default, rename = "webhookUrl")]
    pub webhook_url: Option<String>,
    #[serde(default, rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub events: Vec<String>,
}

fn parse_notification_event_type_from_string(
    event_type_string: &str,
) -> Option<NotificationEventType> {
    match event_type_string {
        "task.started" => Some(NotificationEventType::TaskStarted),
        "task.completed" => Some(NotificationEventType::TaskCompleted),
        "task.failed" => Some(NotificationEventType::TaskFailed),
        "pr.created" => Some(NotificationEventType::PullRequestCreated),
        "trigger.fired" => Some(NotificationEventType::TriggerFired),
        "daily_digest" => Some(NotificationEventType::DailyDigest),
        "cost.warning" => Some(NotificationEventType::CostWarningExceeded),
        _ => None,
    }
}

impl NotificationsFileConfig {
    pub fn build_dispatcher(&self) -> NotificationDispatcher {
        let mut notification_dispatcher = NotificationDispatcher::new();

        for channel_yaml_config in &self.channels {
            let parsed_subscribed_event_types: Vec<NotificationEventType> = channel_yaml_config
                .events
                .iter()
                .filter_map(|event_string| {
                    let parsed_event_type = parse_notification_event_type_from_string(event_string);
                    if parsed_event_type.is_none() {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            event_string = %event_string,
                            "unknown notification event type, skipping"
                        );
                    }
                    parsed_event_type
                })
                .collect();

            match channel_yaml_config.provider.as_str() {
                "slack" => {
                    let Some(raw_webhook_url) = &channel_yaml_config.webhook_url else {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            "slack channel missing webhookUrl, skipping"
                        );
                        continue;
                    };
                    let resolved_webhook_url = substitute_environment_variables(raw_webhook_url);
                    let slack_channel = SlackNotificationChannel::new(
                        channel_yaml_config.name.clone(),
                        resolved_webhook_url,
                        parsed_subscribed_event_types,
                    );
                    notification_dispatcher.add_channel(Box::new(slack_channel));
                }
                "discord" => {
                    let Some(raw_webhook_url) = &channel_yaml_config.webhook_url else {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            "discord channel missing webhookUrl, skipping"
                        );
                        continue;
                    };
                    let resolved_webhook_url = substitute_environment_variables(raw_webhook_url);
                    let discord_channel = DiscordNotificationChannel::new(
                        channel_yaml_config.name.clone(),
                        resolved_webhook_url,
                        parsed_subscribed_event_types,
                    );
                    notification_dispatcher.add_channel(Box::new(discord_channel));
                }
                "email" => {
                    let Some(raw_api_key) = &channel_yaml_config.api_key else {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            "email channel missing apiKey, skipping"
                        );
                        continue;
                    };
                    let Some(from_address) = &channel_yaml_config.from else {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            "email channel missing from address, skipping"
                        );
                        continue;
                    };
                    let Some(to_address) = &channel_yaml_config.to else {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            "email channel missing to address, skipping"
                        );
                        continue;
                    };
                    let resolved_api_key = substitute_environment_variables(raw_api_key);
                    let email_channel = EmailNotificationChannel::new(
                        channel_yaml_config.name.clone(),
                        resolved_api_key,
                        from_address.clone(),
                        to_address.clone(),
                        parsed_subscribed_event_types,
                    );
                    notification_dispatcher.add_channel(Box::new(email_channel));
                }
                "github" => {
                    let Some(raw_token) = &channel_yaml_config.token else {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            "github channel missing token, skipping"
                        );
                        continue;
                    };
                    let Some(raw_repo) = &channel_yaml_config.repo else {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            "github channel missing repo, skipping"
                        );
                        continue;
                    };
                    let resolved_token = substitute_environment_variables(raw_token);
                    let repo_parts: Vec<&str> = raw_repo.split('/').collect();
                    if repo_parts.len() != 2 {
                        warn!(
                            channel_name = %channel_yaml_config.name,
                            repo = %raw_repo,
                            "github channel repo must be in owner/name format, skipping"
                        );
                        continue;
                    }
                    let github_channel = GitHubNotificationChannel::new(
                        channel_yaml_config.name.clone(),
                        resolved_token,
                        repo_parts[0].to_string(),
                        repo_parts[1].to_string(),
                        parsed_subscribed_event_types,
                    );
                    notification_dispatcher.add_channel(Box::new(github_channel));
                }
                "system" => {
                    let system_channel = SystemNotificationChannel::new(
                        channel_yaml_config.name.clone(),
                        parsed_subscribed_event_types,
                    );
                    notification_dispatcher.add_channel(Box::new(system_channel));
                }
                unknown_provider => {
                    warn!(
                        channel_name = %channel_yaml_config.name,
                        provider = %unknown_provider,
                        "unknown notification provider, skipping"
                    );
                }
            }
        }

        notification_dispatcher
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuditConfig {
    #[serde(default = "default_audit_enabled")]
    pub enabled: bool,

    #[serde(rename = "retentionDays", default = "default_audit_retention_days")]
    pub retention_days: u32,

    #[serde(rename = "redactSecrets", default = "default_audit_redact_secrets")]
    pub redact_secrets: bool,

    #[serde(
        rename = "truncateContentBytes",
        default = "default_audit_truncate_bytes"
    )]
    pub truncate_content_bytes: usize,
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            enabled: default_audit_enabled(),
            retention_days: default_audit_retention_days(),
            redact_secrets: default_audit_redact_secrets(),
            truncate_content_bytes: default_audit_truncate_bytes(),
        }
    }
}

fn default_audit_enabled() -> bool {
    true
}
fn default_audit_retention_days() -> u32 {
    90
}
fn default_audit_redact_secrets() -> bool {
    true
}
fn default_audit_truncate_bytes() -> usize {
    10240
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RateLimitsConfig {
    #[serde(rename = "tasksPerTrigger", default)]
    pub tasks_per_trigger: RateWindowConfig,

    #[serde(
        rename = "toolCallsPerSession",
        default = "default_tool_calls_per_session"
    )]
    pub tool_calls_per_session: u32,

    #[serde(rename = "loopDetection", default)]
    pub loop_detection: LoopDetectionConfig,
}

impl Default for RateLimitsConfig {
    fn default() -> Self {
        Self {
            tasks_per_trigger: RateWindowConfig::default(),
            tool_calls_per_session: default_tool_calls_per_session(),
            loop_detection: LoopDetectionConfig::default(),
        }
    }
}

fn default_tool_calls_per_session() -> u32 {
    200
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RateWindowConfig {
    #[serde(rename = "maxEvents", default = "default_rate_max_events")]
    pub max_events: usize,

    #[serde(rename = "windowMinutes", default = "default_rate_window_minutes")]
    pub window_minutes: u64,
}

impl Default for RateWindowConfig {
    fn default() -> Self {
        Self {
            max_events: default_rate_max_events(),
            window_minutes: default_rate_window_minutes(),
        }
    }
}

fn default_rate_max_events() -> usize {
    10
}
fn default_rate_window_minutes() -> u64 {
    5
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoopDetectionConfig {
    #[serde(default = "default_loop_detection_enabled")]
    pub enabled: bool,

    #[serde(rename = "windowMinutes", default = "default_loop_window_minutes")]
    pub window_minutes: u64,

    #[serde(rename = "maxSimilarTasks", default = "default_loop_max_similar_tasks")]
    pub max_similar_tasks: usize,
}

impl Default for LoopDetectionConfig {
    fn default() -> Self {
        Self {
            enabled: default_loop_detection_enabled(),
            window_minutes: default_loop_window_minutes(),
            max_similar_tasks: default_loop_max_similar_tasks(),
        }
    }
}

fn default_loop_detection_enabled() -> bool {
    true
}
fn default_loop_window_minutes() -> u64 {
    10
}
fn default_loop_max_similar_tasks() -> usize {
    3
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ChannelsConfig {
    #[serde(default)]
    pub telegram: Option<TelegramChannelConfig>,

    #[serde(rename = "workerPort", default = "default_channel_worker_port")]
    pub worker_port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelegramChannelConfig {
    pub token: String,

    #[serde(rename = "ownerId")]
    pub owner_id: i64,

    #[serde(default = "default_telegram_enabled")]
    pub enabled: bool,
}

fn default_channel_worker_port() -> u16 {
    7900
}

fn default_telegram_enabled() -> bool {
    true
}

impl ChannelsConfig {
    pub fn has_any_enabled(&self) -> bool {
        self.telegram.as_ref().map(|t| t.enabled).unwrap_or(false)
    }

    pub fn resolved_telegram(&self) -> Option<TelegramChannelConfig> {
        self.telegram.as_ref().and_then(|config| {
            if !config.enabled {
                return None;
            }
            Some(TelegramChannelConfig {
                token: substitute_environment_variables(&config.token),
                owner_id: config.owner_id,
                enabled: config.enabled,
            })
        })
    }
}

fn default_max_retries() -> u32 {
    2
}

fn default_backoff_seconds() -> u64 {
    30
}

fn default_debounce_ms() -> u32 {
    500
}

pub(crate) fn substitute_environment_variables(input: &str) -> String {
    let mut result = input.to_string();
    while let Some(start_position) = result.find("${") {
        if let Some(end_position) = result[start_position..].find('}') {
            let variable_name = &result[start_position + 2..start_position + end_position];
            let replacement_value = std::env::var(variable_name).unwrap_or_default();
            result = format!(
                "{}{}{}",
                &result[..start_position],
                replacement_value,
                &result[start_position + end_position + 1..]
            );
        } else {
            break;
        }
    }
    result
}

impl TriggersFileConfig {
    pub fn expand_sugar_triggers(&self) -> Vec<WebhookTriggerFileConfig> {
        let mut expanded_webhook_configs = Vec::new();

        for ci_failure_config in &self.ci_failures {
            let mut event_filters: Vec<String> = vec!["conclusion equals 'failure'".to_string()];

            if !ci_failure_config.branches.is_empty() {
                let branch_filter_pattern = ci_failure_config
                    .branches
                    .iter()
                    .map(|branch_name| format!("head_branch equals '{branch_name}'"))
                    .collect::<Vec<_>>();

                for branch_filter in branch_filter_pattern {
                    event_filters.push(branch_filter);
                }
            }

            expanded_webhook_configs.push(WebhookTriggerFileConfig {
                name: ci_failure_config.name.clone(),
                provider: "github".to_string(),
                secret: ci_failure_config.secret.clone(),
                events: vec![WebhookEventFileConfig {
                    event_type: "check_suite.completed".to_string(),
                    filter: event_filters,
                    task: ci_failure_config.task.clone(),
                }],
            });
        }

        for pr_mention_config in &self.pr_mentions {
            let mention_filter = format!("body contains '{}'", pr_mention_config.mention);

            expanded_webhook_configs.push(WebhookTriggerFileConfig {
                name: pr_mention_config.name.clone(),
                provider: "github".to_string(),
                secret: pr_mention_config.secret.clone(),
                events: vec![WebhookEventFileConfig {
                    event_type: "pull_request_review_comment.created".to_string(),
                    filter: vec![mention_filter],
                    task: pr_mention_config.task.clone(),
                }],
            });
        }

        expanded_webhook_configs
    }

    pub fn parsed_webhook_trigger_configs(&self) -> Vec<WebhookTriggerConfig> {
        let mut parsed_webhook_configs = Vec::new();

        let sugar_expanded_webhooks = self.expand_sugar_triggers();
        let all_webhook_yaml_configs = self.webhooks.iter().chain(sugar_expanded_webhooks.iter());

        for yaml_webhook in all_webhook_yaml_configs {
            let resolved_secret = substitute_environment_variables(&yaml_webhook.secret);

            let mut parsed_event_configs = Vec::new();

            for yaml_event in &yaml_webhook.events {
                let mut parsed_filters = Vec::new();
                let mut event_has_errors = false;

                for filter_string in &yaml_event.filter {
                    match TriggerFilter::parse(filter_string) {
                        Ok(parsed_filter) => parsed_filters.push(parsed_filter),
                        Err(filter_parse_error) => {
                            warn!(
                                webhook_name = %yaml_webhook.name,
                                event_type = %yaml_event.event_type,
                                filter = %filter_string,
                                error = %filter_parse_error,
                                "skipping webhook event with invalid filter"
                            );
                            event_has_errors = true;
                            break;
                        }
                    }
                }

                if event_has_errors {
                    continue;
                }

                parsed_event_configs.push(WebhookEventConfig {
                    event_type: yaml_event.event_type.clone(),
                    filters: parsed_filters,
                    task_template: yaml_event.task.clone(),
                });
            }

            parsed_webhook_configs.push(WebhookTriggerConfig {
                name: yaml_webhook.name.clone(),
                provider: yaml_webhook.provider.clone(),
                secret: resolved_secret,
                events: parsed_event_configs,
            });
        }

        parsed_webhook_configs
    }

    pub fn parsed_cron_trigger_configs(&self) -> Vec<CronTriggerConfig> {
        self.crons
            .iter()
            .map(|yaml_cron| CronTriggerConfig {
                name: yaml_cron.name.clone(),
                expression: yaml_cron.expression.clone(),
                task_template: yaml_cron.task.clone(),
                branch_prefix: yaml_cron.branch_prefix.clone(),
                model: yaml_cron.model.clone(),
                agent: yaml_cron.agent.clone(),
            })
            .collect()
    }

    pub fn parsed_watcher_trigger_configs(&self) -> Vec<WatcherTriggerConfig> {
        self.watchers
            .iter()
            .map(|yaml_watcher| WatcherTriggerConfig {
                name: yaml_watcher.name.clone(),
                paths: yaml_watcher.paths.clone(),
                ignore_patterns: yaml_watcher.ignore.clone(),
                debounce_ms: yaml_watcher.debounce_ms,
                task_template: yaml_watcher.task.clone(),
            })
            .collect()
    }

    pub fn parsed_slash_command_trigger_configs(&self) -> Vec<SlashCommandTriggerConfig> {
        self.slash_commands
            .iter()
            .map(|yaml_slash_command| {
                let resolved_token = substitute_environment_variables(&yaml_slash_command.token);
                let resolved_app_token = yaml_slash_command
                    .app_token
                    .as_ref()
                    .map(|raw_app_token| substitute_environment_variables(raw_app_token));

                SlashCommandTriggerConfig {
                    name: yaml_slash_command.name.clone(),
                    provider: yaml_slash_command.provider.clone(),
                    token: resolved_token,
                    app_token: resolved_app_token,
                    channel: yaml_slash_command.channel.clone(),
                    task_template: yaml_slash_command.task.clone(),
                    mention: yaml_slash_command.mention.clone(),
                }
            })
            .collect()
    }
}

fn default_database_path() -> String {
    let home_directory = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home_directory
        .join(".kraken")
        .join("daemon.db")
        .to_string_lossy()
        .to_string()
}

fn default_max_concurrent_tasks() -> u32 {
    3
}

fn default_heartbeat_timeout_seconds() -> u64 {
    300
}

fn default_daemon_port() -> u16 {
    50051
}

fn default_webhook_port() -> u16 {
    50052
}

fn default_branch_prefix() -> String {
    "kraken/".to_string()
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            database_path: default_database_path(),
            orchestrator: OrchestratorConfig::default(),
            services: ServicesConfig::default(),
            git: GitConfig::default(),
            triggers: TriggersFileConfig::default(),
            notifications: NotificationsFileConfig::default(),
            costs: CostsConfig::default(),
            language_model: LanguageModelConfig::default(),
            mcp: HashMap::new(),
            audit: AuditConfig::default(),
            rate_limits: RateLimitsConfig::default(),
            channels: ChannelsConfig::default(),
        }
    }
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_concurrent_tasks: default_max_concurrent_tasks(),
            heartbeat_timeout_seconds: default_heartbeat_timeout_seconds(),
            retry: RetryConfig::default(),
        }
    }
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: default_max_retries(),
            backoff_seconds: default_backoff_seconds(),
        }
    }
}

impl Default for ServicesConfig {
    fn default() -> Self {
        Self {
            daemon_port: default_daemon_port(),
            webhook_port: default_webhook_port(),
        }
    }
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            branch_prefix: default_branch_prefix(),
        }
    }
}

impl DaemonConfig {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        for cron_config in &self.triggers.crons {
            if cron::Schedule::from_str(&cron_config.expression).is_err() {
                errors.push(format!(
                    "invalid cron expression '{}' in trigger '{}'",
                    cron_config.expression, cron_config.name
                ));
            }
        }

        if self.services.daemon_port == self.services.webhook_port {
            errors.push(format!(
                "daemonPort ({}) and webhookPort ({}) cannot be the same",
                self.services.daemon_port, self.services.webhook_port
            ));
        }

        for channel in &self.notifications.channels {
            match channel.provider.as_str() {
                "slack" | "discord" if channel.webhook_url.is_none() => {
                    errors.push(format!(
                        "{} channel '{}' is missing webhookUrl",
                        channel.provider, channel.name
                    ));
                }
                "email" => {
                    if channel.api_key.is_none() {
                        errors.push(format!(
                            "email channel '{}' is missing apiKey",
                            channel.name
                        ));
                    }
                    if channel.from.is_none() {
                        errors.push(format!(
                            "email channel '{}' is missing from address",
                            channel.name
                        ));
                    }
                    if channel.to.is_none() {
                        errors.push(format!(
                            "email channel '{}' is missing to address",
                            channel.name
                        ));
                    }
                }
                "github" => {
                    if channel.token.is_none() {
                        errors.push(format!(
                            "github channel '{}' is missing token",
                            channel.name
                        ));
                    }
                    if channel.repo.is_none() {
                        errors.push(format!("github channel '{}' is missing repo", channel.name));
                    }
                }
                _ => {}
            }
        }

        if self.orchestrator.max_concurrent_tasks == 0 {
            errors.push("orchestrator.maxConcurrentTasks must be > 0".to_string());
        }

        if let Some(telegram) = &self.channels.telegram {
            if telegram.enabled && telegram.token.is_empty() {
                errors.push("channels.telegram.token is required when enabled".to_string());
            }
            if telegram.enabled && telegram.owner_id == 0 {
                errors.push("channels.telegram.ownerId is required when enabled".to_string());
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Loads daemon configuration using a three-tier resolution strategy:
    ///
    /// 1. An explicit `config_path` argument (highest priority).
    /// 2. The `KRAKEN_CONFIGURATION_FILE` environment variable.
    /// 3. The default location `~/.kraken/kraken.jsonc`.
    ///
    /// If the resolved file does not exist, returns `DaemonConfig::default()`
    /// with a log message indicating defaults are being used.
    pub fn load(config_path: Option<&Path>) -> Result<Self, String> {
        let resolved_config_path = Self::resolve_config_path(config_path);

        if !resolved_config_path.exists() {
            info!(
                path = %resolved_config_path.display(),
                "configuration file not found, using defaults"
            );
            return Ok(Self::default());
        }

        info!(path = %resolved_config_path.display(), "loading configuration");

        let file_contents = std::fs::read_to_string(&resolved_config_path)
            .map_err(|error| format!("failed to read config file: {error}"))?;

        let stripped_json = strip_jsonc_comments(&file_contents);

        let daemon_config: DaemonConfig = serde_json::from_str(&stripped_json)
            .map_err(|error| format!("failed to parse config JSON: {error}"))?;

        Ok(daemon_config)
    }

    /// Serializes the config to pretty-printed JSON.
    pub fn to_json_pretty(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self)
            .map_err(|error| format!("failed to serialize config: {error}"))
    }

    /// Determines which configuration file path to use, applying the
    /// three-tier fallback: explicit arg -> env var -> default path.
    pub fn resolve_config_path(config_path: Option<&Path>) -> PathBuf {
        if let Some(explicit_path) = config_path {
            return explicit_path.to_path_buf();
        }

        if let Ok(env_path) = std::env::var("KRAKEN_CONFIGURATION_FILE")
            && !env_path.is_empty()
        {
            return PathBuf::from(env_path);
        }

        let home_directory = dirs_next::home_dir().unwrap_or_else(|| {
            warn!("could not determine home directory, falling back to current directory");
            PathBuf::from(".")
        });

        home_directory.join(".kraken").join("kraken.jsonc")
    }
}

/// Strips `//` line comments and `/* */` block comments from JSONC content,
/// preserving strings (so `//` inside a JSON string is not treated as a comment).
pub fn strip_jsonc_comments(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let input_length = bytes.len();
    let mut cursor = 0;

    while cursor < input_length {
        if bytes[cursor] == b'"' {
            output.push('"');
            cursor += 1;
            while cursor < input_length && bytes[cursor] != b'"' {
                if bytes[cursor] == b'\\' && cursor + 1 < input_length {
                    output.push(bytes[cursor] as char);
                    output.push(bytes[cursor + 1] as char);
                    cursor += 2;
                } else {
                    output.push(bytes[cursor] as char);
                    cursor += 1;
                }
            }
            if cursor < input_length {
                output.push('"');
                cursor += 1;
            }
        } else if cursor + 1 < input_length && bytes[cursor] == b'/' && bytes[cursor + 1] == b'/' {
            cursor += 2;
            while cursor < input_length && bytes[cursor] != b'\n' {
                cursor += 1;
            }
        } else if cursor + 1 < input_length && bytes[cursor] == b'/' && bytes[cursor + 1] == b'*' {
            cursor += 2;
            while cursor + 1 < input_length && !(bytes[cursor] == b'*' && bytes[cursor + 1] == b'/')
            {
                cursor += 1;
            }
            if cursor + 1 < input_length {
                cursor += 2;
            }
        } else {
            output.push(bytes[cursor] as char);
            cursor += 1;
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_default_config_values() {
        let config = DaemonConfig::default();

        assert!(config.database_path.contains("daemon.db"));
        assert_eq!(config.orchestrator.max_concurrent_tasks, 3);
        assert_eq!(config.orchestrator.heartbeat_timeout_seconds, 300);
        assert_eq!(config.services.daemon_port, 50051);
        assert_eq!(config.services.webhook_port, 50052);
        assert_eq!(config.git.branch_prefix, "kraken/");
        assert!(config.costs.cost_warning_threshold_usd.is_none());
    }

    #[test]
    fn test_load_returns_defaults_when_file_missing() {
        let nonexistent_path = Path::new("/tmp/kraken_test_nonexistent_config.jsonc");
        let config = DaemonConfig::load(Some(nonexistent_path))
            .expect("should return defaults for missing file");

        assert_eq!(config.orchestrator.max_concurrent_tasks, 3);
    }

    #[test]
    fn test_load_parses_jsonc_file() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_config.jsonc");

        let json_content = r#"{
  "databasePath": "/tmp/test-daemon.db",
  "orchestrator": {
    "maxConcurrentTasks": 5,
    "heartbeatTimeoutSeconds": 120
  },
  "services": {
    "daemonPort": 9001,
    "webhookPort": 9002
  },
  "git": {
    "branchPrefix": "auto/"
  }
}"#;

        let mut config_file =
            std::fs::File::create(&config_file_path).expect("should create test config file");
        config_file
            .write_all(json_content.as_bytes())
            .expect("should write test config");

        let config = DaemonConfig::load(Some(&config_file_path)).expect("should parse test config");

        assert_eq!(config.database_path, "/tmp/test-daemon.db");
        assert_eq!(config.orchestrator.max_concurrent_tasks, 5);
        assert_eq!(config.orchestrator.heartbeat_timeout_seconds, 120);
        assert_eq!(config.services.daemon_port, 9001);
        assert_eq!(config.services.webhook_port, 9002);
        assert_eq!(config.git.branch_prefix, "auto/");

        let _ = std::fs::remove_file(&config_file_path);
    }

    #[test]
    fn test_load_partial_jsonc_uses_defaults_for_missing_fields() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_partial_config.jsonc");

        let json_content = r#"{
  "databasePath": "/tmp/custom-test.db"
}"#;

        let mut config_file =
            std::fs::File::create(&config_file_path).expect("should create test config file");
        config_file
            .write_all(json_content.as_bytes())
            .expect("should write test config");

        let config =
            DaemonConfig::load(Some(&config_file_path)).expect("should parse partial config");

        assert_eq!(config.database_path, "/tmp/custom-test.db");
        assert_eq!(config.orchestrator.max_concurrent_tasks, 3);
        assert_eq!(config.services.daemon_port, 50051);
        assert_eq!(config.git.branch_prefix, "kraken/");

        let _ = std::fs::remove_file(&config_file_path);
    }

    #[test]
    fn test_load_config_with_triggers_section() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_triggers_config.jsonc");

        let json_content = r#"{
  "repo": "/home/user/project",
  "triggers": {
    "crons": [
      {
        "name": "daily-review",
        "expression": "0 0 9 * * *",
        "task": "Review open PRs and summarize status"
      }
    ],
    "webhooks": [
      {
        "name": "github-issues",
        "provider": "github",
        "secret": "test-secret",
        "events": [
          {
            "type": "issues.opened",
            "filter": ["labels contains 'kraken'"],
            "task": "Fix: {{event.issue.title}}"
          }
        ]
      }
    ],
    "watchers": [
      {
        "name": "src-watcher",
        "paths": ["src/"],
        "ignore": ["*.tmp"],
        "debounceMs": 1000,
        "task": "File changed: {{event.path}}"
      }
    ]
  }
}"#;

        let mut config_file =
            std::fs::File::create(&config_file_path).expect("should create test config file");
        config_file
            .write_all(json_content.as_bytes())
            .expect("should write test config");

        let config =
            DaemonConfig::load(Some(&config_file_path)).expect("should parse config with triggers");

        assert_eq!(config.triggers.crons.len(), 1);
        assert_eq!(config.triggers.crons[0].name, "daily-review");
        assert_eq!(config.triggers.crons[0].expression, "0 0 9 * * *");

        assert_eq!(config.triggers.webhooks.len(), 1);
        assert_eq!(config.triggers.webhooks[0].name, "github-issues");
        assert_eq!(config.triggers.webhooks[0].events.len(), 1);
        assert_eq!(config.triggers.webhooks[0].events[0].filter.len(), 1);

        assert_eq!(config.triggers.watchers.len(), 1);
        assert_eq!(config.triggers.watchers[0].name, "src-watcher");
        assert_eq!(config.triggers.watchers[0].debounce_ms, 1000);

        let _ = std::fs::remove_file(&config_file_path);
    }

    #[test]
    fn test_triggers_yaml_config_defaults_to_empty() {
        let config = DaemonConfig::default();
        assert!(config.triggers.crons.is_empty());
        assert!(config.triggers.webhooks.is_empty());
        assert!(config.triggers.watchers.is_empty());
        assert!(config.triggers.ci_failures.is_empty());
        assert!(config.triggers.pr_mentions.is_empty());
        assert!(config.triggers.slash_commands.is_empty());
    }

    #[test]
    fn test_parsed_cron_trigger_configs() {
        let triggers_config = TriggersFileConfig {
            crons: vec![CronTriggerFileConfig {
                name: "daily-review".to_string(),
                expression: "0 0 9 * * *".to_string(),
                task: "Review PRs".to_string(),
                branch_prefix: Some("review/".to_string()),
                model: None,
                agent: None,
            }],
            webhooks: vec![],
            watchers: vec![],
            ci_failures: vec![],
            pr_mentions: vec![],
            slash_commands: vec![],
        };

        let parsed_crons = triggers_config.parsed_cron_trigger_configs();
        assert_eq!(parsed_crons.len(), 1);
        assert_eq!(parsed_crons[0].name, "daily-review");
        assert_eq!(parsed_crons[0].expression, "0 0 9 * * *");
        assert_eq!(parsed_crons[0].task_template, "Review PRs");
        assert_eq!(parsed_crons[0].branch_prefix.as_deref(), Some("review/"));
    }

    #[test]
    fn test_parsed_webhook_trigger_configs_with_valid_filters() {
        let triggers_config = TriggersFileConfig {
            crons: vec![],
            webhooks: vec![WebhookTriggerFileConfig {
                name: "github-issues".to_string(),
                provider: "github".to_string(),
                secret: "my-secret".to_string(),
                events: vec![WebhookEventFileConfig {
                    event_type: "issues.opened".to_string(),
                    filter: vec!["labels contains 'kraken'".to_string()],
                    task: "Fix: {{event.issue.title}}".to_string(),
                }],
            }],
            watchers: vec![],
            ci_failures: vec![],
            pr_mentions: vec![],
            slash_commands: vec![],
        };

        let parsed_webhooks = triggers_config.parsed_webhook_trigger_configs();
        assert_eq!(parsed_webhooks.len(), 1);
        assert_eq!(parsed_webhooks[0].events.len(), 1);
        assert_eq!(parsed_webhooks[0].events[0].filters.len(), 1);
        assert_eq!(parsed_webhooks[0].events[0].filters[0].field, "labels");
    }

    #[test]
    fn test_parsed_webhook_trigger_configs_skips_invalid_filters() {
        let triggers_config = TriggersFileConfig {
            crons: vec![],
            webhooks: vec![WebhookTriggerFileConfig {
                name: "test-webhook".to_string(),
                provider: "github".to_string(),
                secret: "secret".to_string(),
                events: vec![WebhookEventFileConfig {
                    event_type: "push".to_string(),
                    filter: vec!["this has no valid operator".to_string()],
                    task: "Deploy".to_string(),
                }],
            }],
            watchers: vec![],
            ci_failures: vec![],
            pr_mentions: vec![],
            slash_commands: vec![],
        };

        let parsed_webhooks = triggers_config.parsed_webhook_trigger_configs();
        assert_eq!(parsed_webhooks.len(), 1);
        assert_eq!(parsed_webhooks[0].events.len(), 0);
    }

    #[test]
    fn test_parsed_watcher_trigger_configs() {
        let triggers_config = TriggersFileConfig {
            crons: vec![],
            webhooks: vec![],
            watchers: vec![WatcherTriggerFileConfig {
                name: "config-watcher".to_string(),
                paths: vec!["config/".to_string()],
                ignore: vec!["*.bak".to_string()],
                debounce_ms: 2000,
                task: "Config changed".to_string(),
            }],
            ci_failures: vec![],
            pr_mentions: vec![],
            slash_commands: vec![],
        };

        let parsed_watchers = triggers_config.parsed_watcher_trigger_configs();
        assert_eq!(parsed_watchers.len(), 1);
        assert_eq!(parsed_watchers[0].name, "config-watcher");
        assert_eq!(parsed_watchers[0].paths, vec!["config/"]);
        assert_eq!(parsed_watchers[0].ignore_patterns, vec!["*.bak"]);
        assert_eq!(parsed_watchers[0].debounce_ms, 2000);
        assert_eq!(parsed_watchers[0].task_template, "Config changed");
    }

    #[test]
    fn test_substitute_environment_variables_in_secret() {
        unsafe {
            std::env::set_var("KRAKEN_TEST_WEBHOOK_SECRET", "real-secret-value");
        }

        let result = super::substitute_environment_variables("${KRAKEN_TEST_WEBHOOK_SECRET}");
        assert_eq!(result, "real-secret-value");

        unsafe {
            std::env::remove_var("KRAKEN_TEST_WEBHOOK_SECRET");
        }
    }

    #[test]
    fn test_substitute_environment_variables_with_missing_var() {
        unsafe {
            std::env::remove_var("KRAKEN_NONEXISTENT_VAR_12345");
        }

        let result = super::substitute_environment_variables("${KRAKEN_NONEXISTENT_VAR_12345}");
        assert_eq!(result, "");
    }

    #[test]
    fn test_substitute_environment_variables_with_no_placeholders() {
        let result = super::substitute_environment_variables("plain-secret");
        assert_eq!(result, "plain-secret");
    }

    #[test]
    fn test_parse_notification_event_type_from_string_valid_types() {
        use super::parse_notification_event_type_from_string;
        use crate::notifications::types::NotificationEventType;

        assert_eq!(
            parse_notification_event_type_from_string("task.started"),
            Some(NotificationEventType::TaskStarted)
        );
        assert_eq!(
            parse_notification_event_type_from_string("task.completed"),
            Some(NotificationEventType::TaskCompleted)
        );
        assert_eq!(
            parse_notification_event_type_from_string("task.failed"),
            Some(NotificationEventType::TaskFailed)
        );
        assert_eq!(
            parse_notification_event_type_from_string("pr.created"),
            Some(NotificationEventType::PullRequestCreated)
        );
        assert_eq!(
            parse_notification_event_type_from_string("trigger.fired"),
            Some(NotificationEventType::TriggerFired)
        );
        assert_eq!(
            parse_notification_event_type_from_string("daily_digest"),
            Some(NotificationEventType::DailyDigest)
        );
        assert_eq!(
            parse_notification_event_type_from_string("cost.warning"),
            Some(NotificationEventType::CostWarningExceeded)
        );
    }

    #[test]
    fn test_parse_notification_event_type_from_string_unknown_returns_none() {
        use super::parse_notification_event_type_from_string;

        assert_eq!(
            parse_notification_event_type_from_string("unknown.event"),
            None
        );
        assert_eq!(parse_notification_event_type_from_string(""), None);
        assert_eq!(
            parse_notification_event_type_from_string("task_completed"),
            None
        );
    }

    #[test]
    fn test_notifications_yaml_config_defaults_to_empty() {
        let config = DaemonConfig::default();
        assert!(config.notifications.channels.is_empty());
    }

    #[test]
    fn test_build_dispatcher_creates_slack_channel() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "team-slack".to_string(),
                provider: "slack".to_string(),
                webhook_url: Some("https://hooks.slack.com/services/T00/B00/xxx".to_string()),
                api_key: None,
                token: None,
                repo: None,
                from: None,
                to: None,
                events: vec!["task.completed".to_string(), "task.failed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 1);
    }

    #[test]
    fn test_build_dispatcher_creates_discord_channel() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "dev-discord".to_string(),
                provider: "discord".to_string(),
                webhook_url: Some("https://discord.com/api/webhooks/123/abc".to_string()),
                api_key: None,
                token: None,
                repo: None,
                from: None,
                to: None,
                events: vec!["task.completed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 1);
    }

    #[test]
    fn test_build_dispatcher_creates_email_channel() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "email-alerts".to_string(),
                provider: "email".to_string(),
                webhook_url: None,
                api_key: Some("re_test_key".to_string()),
                token: None,
                repo: None,
                from: Some("Kraken <noreply@kraken.dev>".to_string()),
                to: Some("dev@company.com".to_string()),
                events: vec!["task.failed".to_string(), "daily_digest".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 1);
    }

    #[test]
    fn test_build_dispatcher_creates_system_channel() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "desktop".to_string(),
                provider: "system".to_string(),
                webhook_url: None,
                api_key: None,
                token: None,
                repo: None,
                from: None,
                to: None,
                events: vec!["task.completed".to_string(), "task.failed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 1);
    }

    #[test]
    fn test_build_dispatcher_skips_slack_channel_without_webhook_url() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "broken-slack".to_string(),
                provider: "slack".to_string(),
                webhook_url: None,
                api_key: None,
                token: None,
                repo: None,
                from: None,
                to: None,
                events: vec!["task.completed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 0);
    }

    #[test]
    fn test_build_dispatcher_skips_discord_channel_without_webhook_url() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "broken-discord".to_string(),
                provider: "discord".to_string(),
                webhook_url: None,
                api_key: None,
                token: None,
                repo: None,
                from: None,
                to: None,
                events: vec!["task.completed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 0);
    }

    #[test]
    fn test_build_dispatcher_skips_email_channel_without_api_key() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "broken-email".to_string(),
                provider: "email".to_string(),
                webhook_url: None,
                api_key: None,
                token: None,
                repo: None,
                from: Some("from@test.com".to_string()),
                to: Some("to@test.com".to_string()),
                events: vec!["task.completed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 0);
    }

    #[test]
    fn test_build_dispatcher_skips_email_channel_without_from_address() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "broken-email".to_string(),
                provider: "email".to_string(),
                webhook_url: None,
                api_key: Some("re_key".to_string()),
                token: None,
                repo: None,
                from: None,
                to: Some("to@test.com".to_string()),
                events: vec!["task.completed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 0);
    }

    #[test]
    fn test_build_dispatcher_skips_email_channel_without_to_address() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "broken-email".to_string(),
                provider: "email".to_string(),
                webhook_url: None,
                api_key: Some("re_key".to_string()),
                token: None,
                repo: None,
                from: Some("from@test.com".to_string()),
                to: None,
                events: vec!["task.completed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 0);
    }

    #[test]
    fn test_build_dispatcher_skips_unknown_provider() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "unknown-channel".to_string(),
                provider: "telegram".to_string(),
                webhook_url: Some("https://t.me/webhook".to_string()),
                api_key: None,
                token: None,
                repo: None,
                from: None,
                to: None,
                events: vec!["task.completed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 0);
    }

    #[test]
    fn test_build_dispatcher_creates_multiple_channels() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![
                NotificationChannelFileConfig {
                    name: "team-slack".to_string(),
                    provider: "slack".to_string(),
                    webhook_url: Some("https://hooks.slack.com/services/T00/B00/xxx".to_string()),
                    api_key: None,
                    token: None,
                    repo: None,
                    from: None,
                    to: None,
                    events: vec!["task.completed".to_string()],
                },
                NotificationChannelFileConfig {
                    name: "desktop".to_string(),
                    provider: "system".to_string(),
                    webhook_url: None,
                    api_key: None,
                    token: None,
                    repo: None,
                    from: None,
                    to: None,
                    events: vec!["task.failed".to_string()],
                },
            ],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 2);
    }

    #[test]
    fn test_build_dispatcher_skips_unknown_events_but_keeps_valid_ones() {
        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "system-channel".to_string(),
                provider: "system".to_string(),
                webhook_url: None,
                api_key: None,
                token: None,
                repo: None,
                from: None,
                to: None,
                events: vec![
                    "task.completed".to_string(),
                    "bogus.event".to_string(),
                    "task.failed".to_string(),
                ],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 1);
    }

    #[test]
    fn test_build_dispatcher_with_env_var_substitution_in_webhook_url() {
        unsafe {
            std::env::set_var(
                "KRAKEN_TEST_SLACK_WEBHOOK",
                "https://hooks.slack.com/resolved",
            );
        }

        let notifications_config = NotificationsFileConfig {
            channels: vec![NotificationChannelFileConfig {
                name: "env-slack".to_string(),
                provider: "slack".to_string(),
                webhook_url: Some("${KRAKEN_TEST_SLACK_WEBHOOK}".to_string()),
                api_key: None,
                token: None,
                repo: None,
                from: None,
                to: None,
                events: vec!["task.completed".to_string()],
            }],
        };

        let dispatcher = notifications_config.build_dispatcher();
        assert_eq!(dispatcher.channel_count(), 1);

        unsafe {
            std::env::remove_var("KRAKEN_TEST_SLACK_WEBHOOK");
        }
    }

    #[test]
    fn test_load_config_with_notifications_section() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_notifications_config.jsonc");

        let json_content = r#"{
  "repo": "/home/user/project",
  "notifications": {
    "channels": [
      {
        "name": "team-slack",
        "provider": "slack",
        "webhookUrl": "https://hooks.slack.com/services/T00/B00/xxx",
        "events": ["task.completed", "task.failed"]
      },
      {
        "name": "desktop",
        "provider": "system",
        "events": ["task.completed"]
      }
    ]
  }
}"#;

        let mut config_file =
            std::fs::File::create(&config_file_path).expect("should create test config file");
        config_file
            .write_all(json_content.as_bytes())
            .expect("should write test config");

        let config = DaemonConfig::load(Some(&config_file_path))
            .expect("should parse config with notifications");

        assert_eq!(config.notifications.channels.len(), 2);
        assert_eq!(config.notifications.channels[0].name, "team-slack");
        assert_eq!(config.notifications.channels[0].provider, "slack");
        assert_eq!(config.notifications.channels[0].events.len(), 2);
        assert_eq!(config.notifications.channels[1].name, "desktop");
        assert_eq!(config.notifications.channels[1].provider, "system");

        let _ = std::fs::remove_file(&config_file_path);
    }

    #[test]
    fn test_load_config_with_costs_section() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_costs_config.jsonc");

        let json_content = r#"{
  "repo": "/home/user/project",
  "costs": {
    "costWarningThresholdUsd": 5.50
  }
}"#;

        let mut config_file =
            std::fs::File::create(&config_file_path).expect("should create test config file");
        config_file
            .write_all(json_content.as_bytes())
            .expect("should write test config");

        let config =
            DaemonConfig::load(Some(&config_file_path)).expect("should parse config with costs");

        assert_eq!(config.costs.cost_warning_threshold_usd, Some(5.50));

        let _ = std::fs::remove_file(&config_file_path);
    }

    #[test]
    fn test_load_config_without_costs_section_defaults_to_none() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_no_costs_config.jsonc");

        let json_content = r#"{
  "repo": "/home/user/project"
}"#;

        let mut config_file =
            std::fs::File::create(&config_file_path).expect("should create test config file");
        config_file
            .write_all(json_content.as_bytes())
            .expect("should write test config");

        let config =
            DaemonConfig::load(Some(&config_file_path)).expect("should parse config without costs");

        assert!(config.costs.cost_warning_threshold_usd.is_none());

        let _ = std::fs::remove_file(&config_file_path);
    }

    // -- Sugar trigger expansion tests ----------------------------------------

    #[test]
    fn test_expand_ci_failure_without_branches_produces_single_conclusion_filter() {
        let triggers_config = TriggersFileConfig {
            crons: vec![],
            webhooks: vec![],
            watchers: vec![],
            ci_failures: vec![CiFailureTriggerFileConfig {
                name: "ci-fail-all-branches".to_string(),
                repo: "owner/repo".to_string(),
                branches: vec![],
                task: "Fix CI failure on {{event.head_branch}}".to_string(),
                secret: default_github_webhook_secret_ref(),
            }],
            pr_mentions: vec![],
            slash_commands: vec![],
        };

        let expanded_webhooks = triggers_config.expand_sugar_triggers();
        assert_eq!(expanded_webhooks.len(), 1);
        assert_eq!(expanded_webhooks[0].name, "ci-fail-all-branches");
        assert_eq!(expanded_webhooks[0].provider, "github");
        assert_eq!(expanded_webhooks[0].events.len(), 1);
        assert_eq!(
            expanded_webhooks[0].events[0].event_type,
            "check_suite.completed"
        );
        assert_eq!(expanded_webhooks[0].events[0].filter.len(), 1);
        assert_eq!(
            expanded_webhooks[0].events[0].filter[0],
            "conclusion equals 'failure'"
        );
        assert_eq!(
            expanded_webhooks[0].events[0].task,
            "Fix CI failure on {{event.head_branch}}"
        );
    }

    #[test]
    fn test_expand_ci_failure_with_branches_adds_branch_filters() {
        let triggers_config = TriggersFileConfig {
            crons: vec![],
            webhooks: vec![],
            watchers: vec![],
            ci_failures: vec![CiFailureTriggerFileConfig {
                name: "ci-fail-main-develop".to_string(),
                repo: "owner/repo".to_string(),
                branches: vec!["main".to_string(), "develop".to_string()],
                task: "Investigate CI failure".to_string(),
                secret: default_github_webhook_secret_ref(),
            }],
            pr_mentions: vec![],
            slash_commands: vec![],
        };

        let expanded_webhooks = triggers_config.expand_sugar_triggers();
        assert_eq!(expanded_webhooks.len(), 1);
        assert_eq!(expanded_webhooks[0].events[0].filter.len(), 3);
        assert_eq!(
            expanded_webhooks[0].events[0].filter[0],
            "conclusion equals 'failure'"
        );
        assert_eq!(
            expanded_webhooks[0].events[0].filter[1],
            "head_branch equals 'main'"
        );
        assert_eq!(
            expanded_webhooks[0].events[0].filter[2],
            "head_branch equals 'develop'"
        );
    }

    #[test]
    fn test_expand_pr_mention_with_default_mention_keyword() {
        let triggers_config = TriggersFileConfig {
            crons: vec![],
            webhooks: vec![],
            watchers: vec![],
            ci_failures: vec![],
            pr_mentions: vec![PrMentionTriggerFileConfig {
                name: "pr-mention-default".to_string(),
                repo: "owner/repo".to_string(),
                mention: default_pr_mention_keyword(),
                task: "Respond to PR mention".to_string(),
                secret: default_github_webhook_secret_ref(),
            }],
            slash_commands: vec![],
        };

        let expanded_webhooks = triggers_config.expand_sugar_triggers();
        assert_eq!(expanded_webhooks.len(), 1);
        assert_eq!(expanded_webhooks[0].name, "pr-mention-default");
        assert_eq!(expanded_webhooks[0].provider, "github");
        assert_eq!(expanded_webhooks[0].events.len(), 1);
        assert_eq!(
            expanded_webhooks[0].events[0].event_type,
            "pull_request_review_comment.created"
        );
        assert_eq!(expanded_webhooks[0].events[0].filter.len(), 1);
        assert_eq!(
            expanded_webhooks[0].events[0].filter[0],
            "body contains '@kraken'"
        );
        assert_eq!(expanded_webhooks[0].events[0].task, "Respond to PR mention");
    }

    #[test]
    fn test_expand_pr_mention_with_custom_mention_keyword() {
        let triggers_config = TriggersFileConfig {
            crons: vec![],
            webhooks: vec![],
            watchers: vec![],
            ci_failures: vec![],
            pr_mentions: vec![PrMentionTriggerFileConfig {
                name: "pr-mention-custom".to_string(),
                repo: "owner/repo".to_string(),
                mention: "@mybot".to_string(),
                task: "Handle custom mention".to_string(),
                secret: default_github_webhook_secret_ref(),
            }],
            slash_commands: vec![],
        };

        let expanded_webhooks = triggers_config.expand_sugar_triggers();
        assert_eq!(expanded_webhooks.len(), 1);
        assert_eq!(
            expanded_webhooks[0].events[0].filter[0],
            "body contains '@mybot'"
        );
    }

    #[test]
    fn test_sugar_triggers_merge_with_explicit_webhooks() {
        let triggers_config = TriggersFileConfig {
            crons: vec![],
            webhooks: vec![WebhookTriggerFileConfig {
                name: "explicit-webhook".to_string(),
                provider: "github".to_string(),
                secret: "my-secret".to_string(),
                events: vec![WebhookEventFileConfig {
                    event_type: "push".to_string(),
                    filter: vec![],
                    task: "Deploy on push".to_string(),
                }],
            }],
            watchers: vec![],
            ci_failures: vec![CiFailureTriggerFileConfig {
                name: "ci-sugar".to_string(),
                repo: "owner/repo".to_string(),
                branches: vec![],
                task: "Fix CI".to_string(),
                secret: default_github_webhook_secret_ref(),
            }],
            pr_mentions: vec![PrMentionTriggerFileConfig {
                name: "pr-sugar".to_string(),
                repo: "owner/repo".to_string(),
                mention: "@kraken".to_string(),
                task: "Handle mention".to_string(),
                secret: default_github_webhook_secret_ref(),
            }],
            slash_commands: vec![],
        };

        let parsed_webhooks = triggers_config.parsed_webhook_trigger_configs();
        assert_eq!(parsed_webhooks.len(), 3);
        assert_eq!(parsed_webhooks[0].name, "explicit-webhook");
        assert_eq!(parsed_webhooks[1].name, "ci-sugar");
        assert_eq!(parsed_webhooks[2].name, "pr-sugar");
    }

    #[test]
    fn test_load_config_with_ci_failures_and_pr_mentions_jsonc() {
        let temporary_directory = std::env::temp_dir();
        let config_file_path = temporary_directory.join("kraken_test_sugar_triggers_config.jsonc");

        let json_content = r#"{
  "repo": "/home/user/project",
  "triggers": {
    "ci_failures": [
      {
        "name": "ci-watch",
        "repo": "owner/repo",
        "branches": ["main"],
        "task": "Fix CI on {{event.head_branch}}"
      }
    ],
    "pr_mentions": [
      {
        "name": "pr-watch",
        "repo": "owner/repo",
        "mention": "@helper",
        "task": "Review PR comment"
      }
    ]
  }
}"#;

        let mut config_file =
            std::fs::File::create(&config_file_path).expect("should create test config file");
        config_file
            .write_all(json_content.as_bytes())
            .expect("should write test config");

        let config = DaemonConfig::load(Some(&config_file_path))
            .expect("should parse config with sugar triggers");

        assert_eq!(config.triggers.ci_failures.len(), 1);
        assert_eq!(config.triggers.ci_failures[0].name, "ci-watch");
        assert_eq!(config.triggers.ci_failures[0].repo, "owner/repo");
        assert_eq!(config.triggers.ci_failures[0].branches, vec!["main"]);

        assert_eq!(config.triggers.pr_mentions.len(), 1);
        assert_eq!(config.triggers.pr_mentions[0].name, "pr-watch");
        assert_eq!(config.triggers.pr_mentions[0].mention, "@helper");

        let parsed_webhooks = config.triggers.parsed_webhook_trigger_configs();
        assert_eq!(parsed_webhooks.len(), 2);
        assert_eq!(parsed_webhooks[0].name, "ci-watch");
        assert_eq!(
            parsed_webhooks[0].events[0].event_type,
            "check_suite.completed"
        );
        assert_eq!(parsed_webhooks[1].name, "pr-watch");
        assert_eq!(
            parsed_webhooks[1].events[0].event_type,
            "pull_request_review_comment.created"
        );

        let _ = std::fs::remove_file(&config_file_path);
    }
}
