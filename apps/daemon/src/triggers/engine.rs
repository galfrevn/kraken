use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::db::tasks::TaskStore;
use super::types::{
    CronTriggerConfig, TriggerEvent, TriggerType, WatcherTriggerConfig,
    WebhookTriggerConfig, render_template,
};

pub struct TriggerEngine {
    task_store: Arc<TaskStore>,
    webhook_configs: RwLock<Vec<WebhookTriggerConfig>>,
    cron_configs: RwLock<Vec<CronTriggerConfig>>,
    watcher_configs: RwLock<Vec<WatcherTriggerConfig>>,
}

impl TriggerEngine {
    pub fn new(
        task_store: Arc<TaskStore>,
        webhook_configs: Vec<WebhookTriggerConfig>,
        cron_configs: Vec<CronTriggerConfig>,
        watcher_configs: Vec<WatcherTriggerConfig>,
    ) -> Self {
        Self {
            task_store,
            webhook_configs: RwLock::new(webhook_configs),
            cron_configs: RwLock::new(cron_configs),
            watcher_configs: RwLock::new(watcher_configs),
        }
    }

    pub async fn update_configs(
        &self,
        new_webhook_configs: Vec<WebhookTriggerConfig>,
        new_cron_configs: Vec<CronTriggerConfig>,
        new_watcher_configs: Vec<WatcherTriggerConfig>,
    ) {
        *self.webhook_configs.write().await = new_webhook_configs;
        *self.cron_configs.write().await = new_cron_configs;
        *self.watcher_configs.write().await = new_watcher_configs;
        info!("trigger engine configs updated");
    }

    pub async fn handle_trigger_event(&self, event: TriggerEvent) -> Option<String> {
        match event.trigger_type {
            TriggerType::Webhook => self.handle_webhook_event(&event).await,
            TriggerType::Cron => self.handle_cron_event(&event).await,
            TriggerType::FileChange => self.handle_file_change_event(&event).await,
            TriggerType::SlashCommand => self.handle_slash_command_event(&event).await,
        }
    }

    async fn handle_webhook_event(&self, event: &TriggerEvent) -> Option<String> {
        let event_type_from_source = extract_event_type_from_source(&event.source);
        let webhook_configs_guard = self.webhook_configs.read().await;

        for webhook_config in webhook_configs_guard.iter() {
            for webhook_event_config in &webhook_config.events {
                if webhook_event_config.event_type != event_type_from_source {
                    continue;
                }

                let all_filters_pass = webhook_event_config
                    .filters
                    .iter()
                    .all(|filter| filter.evaluate(&event.payload));

                if !all_filters_pass {
                    continue;
                }

                let rendered_task_description =
                    render_template(&webhook_event_config.task_template, &event.payload);

                info!(
                    trigger_source = %event.source,
                    webhook_name = %webhook_config.name,
                    event_type = %webhook_event_config.event_type,
                    "webhook trigger matched, creating task"
                );

                return self
                    .create_task_from_trigger(&rendered_task_description, event)
                    .await;
            }
        }

        warn!(
            trigger_source = %event.source,
            "no matching webhook config found"
        );
        None
    }

    async fn handle_cron_event(&self, event: &TriggerEvent) -> Option<String> {
        let cron_configs_guard = self.cron_configs.read().await;
        for cron_config in cron_configs_guard.iter() {
            let expected_source = format!("cron:{}", cron_config.name);
            if event.source != expected_source {
                continue;
            }

            let rendered_task_description =
                render_template(&cron_config.task_template, &event.payload);

            info!(
                trigger_source = %event.source,
                cron_name = %cron_config.name,
                "cron trigger matched, creating task"
            );

            return self
                .create_task_from_trigger(&rendered_task_description, event)
                .await;
        }

        warn!(
            trigger_source = %event.source,
            "no matching cron config found"
        );
        None
    }

    async fn handle_file_change_event(&self, event: &TriggerEvent) -> Option<String> {
        let watcher_configs_guard = self.watcher_configs.read().await;
        for watcher_config in watcher_configs_guard.iter() {
            let expected_source = format!("file_change:{}", watcher_config.name);
            if event.source != expected_source {
                continue;
            }

            let rendered_task_description =
                render_template(&watcher_config.task_template, &event.payload);

            info!(
                trigger_source = %event.source,
                watcher_name = %watcher_config.name,
                "file change trigger matched, creating task"
            );

            return self
                .create_task_from_trigger(&rendered_task_description, event)
                .await;
        }

        warn!(
            trigger_source = %event.source,
            "no matching watcher config found"
        );
        None
    }

    async fn handle_slash_command_event(&self, event: &TriggerEvent) -> Option<String> {
        let task_description = event
            .payload
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or("slash command task")
            .to_string();

        info!(
            trigger_source = %event.source,
            "slash command trigger, creating task"
        );

        self.create_task_from_trigger(&task_description, event).await
    }

    async fn create_task_from_trigger(
        &self,
        task_description: &str,
        event: &TriggerEvent,
    ) -> Option<String> {
        let task_name = format!("[{}] {}", event.trigger_type, truncate_string(task_description, 120));

        match self
            .task_store
            .create_task(&task_name, task_description, 5)
            .await
        {
            Ok(created_task) => {
                info!(
                    task_id = %created_task.id,
                    task_name = %created_task.name,
                    "task created from trigger"
                );
                Some(created_task.id)
            }
            Err(creation_error) => {
                warn!(
                    error = %creation_error,
                    trigger_source = %event.source,
                    "failed to create task from trigger"
                );
                None
            }
        }
    }
}

fn extract_event_type_from_source(source: &str) -> String {
    // Source format: "webhook:provider:event_type" (e.g., "webhook:github:issues.opened")
    let segments: Vec<&str> = source.splitn(3, ':').collect();
    if segments.len() >= 3 {
        segments[2].to_string()
    } else if segments.len() == 2 {
        segments[1].to_string()
    } else {
        source.to_string()
    }
}

fn truncate_string(input: &str, max_length: usize) -> String {
    if input.len() <= max_length {
        input.to_string()
    } else {
        format!("{}...", &input[..max_length])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;
    use crate::triggers::types::{
        FilterOperator, TriggerFilter, WebhookEventConfig,
    };
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    async fn create_test_task_store() -> Arc<TaskStore> {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory.join(format!(
            "kraken_test_trigger_engine_{}.sqlite",
            Uuid::new_v4()
        ));

        let database_pool =
            open_database(&database_path).expect("should open test database");

        Arc::new(TaskStore::new(database_pool))
    }

    fn create_test_trigger_event(
        trigger_type: TriggerType,
        source: &str,
        payload: serde_json::Value,
    ) -> TriggerEvent {
        TriggerEvent {
            id: Uuid::new_v4().to_string(),
            trigger_type,
            source: source.to_string(),
            payload,
            fired_at: Utc::now(),
        }
    }

    #[test]
    fn test_extract_event_type_full_source() {
        let event_type = extract_event_type_from_source("webhook:github:issues.opened");
        assert_eq!(event_type, "issues.opened");
    }

    #[test]
    fn test_extract_event_type_two_segments() {
        let event_type = extract_event_type_from_source("webhook:push");
        assert_eq!(event_type, "push");
    }

    #[test]
    fn test_extract_event_type_single_segment() {
        let event_type = extract_event_type_from_source("push");
        assert_eq!(event_type, "push");
    }

    #[tokio::test]
    async fn test_handle_webhook_event_matching_config() {
        let task_store = create_test_task_store().await;

        let webhook_configs = vec![WebhookTriggerConfig {
            name: "github-issues".to_string(),
            provider: "github".to_string(),
            secret: "test-secret".to_string(),
            events: vec![WebhookEventConfig {
                event_type: "issues.opened".to_string(),
                filters: vec![],
                task_template: "Fix: {{event.issue.title}}".to_string(),
            }],
        }];

        let engine = TriggerEngine::new(
            task_store.clone(),
            webhook_configs,
            vec![],
            vec![],
        );

        let event = create_test_trigger_event(
            TriggerType::Webhook,
            "webhook:github:issues.opened",
            json!({
                "issue": {
                    "title": "Login page crashes",
                    "number": 42
                }
            }),
        );

        let task_id = engine.handle_trigger_event(event).await;
        assert!(task_id.is_some());

        let created_task = task_store
            .get_task(&task_id.unwrap())
            .await
            .expect("task should exist");
        assert!(created_task.description.contains("Fix: Login page crashes"));
    }

    #[tokio::test]
    async fn test_handle_webhook_event_with_filter_pass() {
        let task_store = create_test_task_store().await;

        let webhook_configs = vec![WebhookTriggerConfig {
            name: "github-issues".to_string(),
            provider: "github".to_string(),
            secret: "test-secret".to_string(),
            events: vec![WebhookEventConfig {
                event_type: "issues.opened".to_string(),
                filters: vec![TriggerFilter {
                    field: "issue.labels".to_string(),
                    operator: FilterOperator::Contains,
                    value: "kraken".to_string(),
                }],
                task_template: "Handle: {{event.issue.title}}".to_string(),
            }],
        }];

        let engine = TriggerEngine::new(task_store.clone(), webhook_configs, vec![], vec![]);

        let event = create_test_trigger_event(
            TriggerType::Webhook,
            "webhook:github:issues.opened",
            json!({
                "issue": {
                    "title": "Auto-fix needed",
                    "labels": ["kraken", "bug"]
                }
            }),
        );

        let task_id = engine.handle_trigger_event(event).await;
        assert!(task_id.is_some());
    }

    #[tokio::test]
    async fn test_handle_webhook_event_with_filter_fail() {
        let task_store = create_test_task_store().await;

        let webhook_configs = vec![WebhookTriggerConfig {
            name: "github-issues".to_string(),
            provider: "github".to_string(),
            secret: "test-secret".to_string(),
            events: vec![WebhookEventConfig {
                event_type: "issues.opened".to_string(),
                filters: vec![TriggerFilter {
                    field: "issue.labels".to_string(),
                    operator: FilterOperator::Contains,
                    value: "kraken".to_string(),
                }],
                task_template: "Handle: {{event.issue.title}}".to_string(),
            }],
        }];

        let engine = TriggerEngine::new(task_store.clone(), webhook_configs, vec![], vec![]);

        let event = create_test_trigger_event(
            TriggerType::Webhook,
            "webhook:github:issues.opened",
            json!({
                "issue": {
                    "title": "Unrelated issue",
                    "labels": ["bug"]
                }
            }),
        );

        let task_id = engine.handle_trigger_event(event).await;
        assert!(task_id.is_none());
    }

    #[tokio::test]
    async fn test_handle_webhook_event_no_matching_config() {
        let task_store = create_test_task_store().await;
        let engine = TriggerEngine::new(task_store, vec![], vec![], vec![]);

        let event = create_test_trigger_event(
            TriggerType::Webhook,
            "webhook:github:push",
            json!({}),
        );

        let task_id = engine.handle_trigger_event(event).await;
        assert!(task_id.is_none());
    }

    #[tokio::test]
    async fn test_handle_cron_event_matching_config() {
        let task_store = create_test_task_store().await;

        let cron_configs = vec![CronTriggerConfig {
            name: "daily-review".to_string(),
            expression: "0 9 * * *".to_string(),
            task_template: "Daily code review for {{event.date}}".to_string(),
            branch_prefix: None,
        }];

        let engine = TriggerEngine::new(task_store.clone(), vec![], cron_configs, vec![]);

        let event = create_test_trigger_event(
            TriggerType::Cron,
            "cron:daily-review",
            json!({"date": "2026-03-14"}),
        );

        let task_id = engine.handle_trigger_event(event).await;
        assert!(task_id.is_some());

        let created_task = task_store
            .get_task(&task_id.unwrap())
            .await
            .expect("task should exist");
        assert!(created_task.description.contains("Daily code review for 2026-03-14"));
    }

    #[tokio::test]
    async fn test_handle_cron_event_no_matching_config() {
        let task_store = create_test_task_store().await;

        let cron_configs = vec![CronTriggerConfig {
            name: "daily-review".to_string(),
            expression: "0 9 * * *".to_string(),
            task_template: "Review".to_string(),
            branch_prefix: None,
        }];

        let engine = TriggerEngine::new(task_store, vec![], cron_configs, vec![]);

        let event = create_test_trigger_event(
            TriggerType::Cron,
            "cron:unknown-job",
            json!({}),
        );

        let task_id = engine.handle_trigger_event(event).await;
        assert!(task_id.is_none());
    }

    #[tokio::test]
    async fn test_handle_file_change_event_matching_config() {
        let task_store = create_test_task_store().await;

        let watcher_configs = vec![WatcherTriggerConfig {
            name: "src-watcher".to_string(),
            paths: vec!["src/".to_string()],
            ignore_patterns: vec![],
            debounce_ms: 500,
            task_template: "File changed: {{event.path}}".to_string(),
        }];

        let engine = TriggerEngine::new(task_store.clone(), vec![], vec![], watcher_configs);

        let event = create_test_trigger_event(
            TriggerType::FileChange,
            "file_change:src-watcher",
            json!({"path": "src/main.rs"}),
        );

        let task_id = engine.handle_trigger_event(event).await;
        assert!(task_id.is_some());

        let created_task = task_store
            .get_task(&task_id.unwrap())
            .await
            .expect("task should exist");
        assert!(created_task.description.contains("File changed: src/main.rs"));
    }

    #[tokio::test]
    async fn test_handle_slash_command_event() {
        let task_store = create_test_task_store().await;
        let engine = TriggerEngine::new(task_store.clone(), vec![], vec![], vec![]);

        let event = create_test_trigger_event(
            TriggerType::SlashCommand,
            "slash:fix",
            json!({"command": "Fix the broken CI pipeline"}),
        );

        let task_id = engine.handle_trigger_event(event).await;
        assert!(task_id.is_some());

        let created_task = task_store
            .get_task(&task_id.unwrap())
            .await
            .expect("task should exist");
        assert!(created_task.description.contains("Fix the broken CI pipeline"));
    }

    #[test]
    fn test_truncate_string_short() {
        assert_eq!(truncate_string("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_string_long() {
        let long_input = "a".repeat(200);
        let truncated = truncate_string(&long_input, 50);
        assert_eq!(truncated.len(), 53); // 50 chars + "..."
        assert!(truncated.ends_with("..."));
    }
}
