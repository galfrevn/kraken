use async_trait::async_trait;
use serde_json::{json, Value};

use super::types::{NotificationChannel, NotificationEvent, NotificationEventType};

const DISCORD_COLOR_GREEN: u32 = 3_066_993;
const DISCORD_COLOR_RED: u32 = 15_158_332;
const DISCORD_COLOR_BLUE: u32 = 3_447_003;

pub struct DiscordNotificationChannel {
    channel_name: String,
    webhook_url: String,
    subscribed_event_types: Vec<NotificationEventType>,
    http_client: reqwest::Client,
}

impl DiscordNotificationChannel {
    pub fn new(
        channel_name: String,
        webhook_url: String,
        subscribed_event_types: Vec<NotificationEventType>,
    ) -> Self {
        DiscordNotificationChannel {
            channel_name,
            webhook_url,
            subscribed_event_types,
            http_client: reqwest::Client::new(),
        }
    }

    pub fn build_discord_embeds_payload(notification_event: &NotificationEvent) -> Value {
        let (embed_title, embed_description, embed_color) =
            Self::format_title_description_and_color_for_event(notification_event);

        json!({
            "embeds": [
                {
                    "title": embed_title,
                    "description": embed_description,
                    "color": embed_color
                }
            ]
        })
    }

    fn format_title_description_and_color_for_event(
        notification_event: &NotificationEvent,
    ) -> (String, String, u32) {
        match notification_event.event_type {
            NotificationEventType::TaskCompleted => {
                let embed_title = "Task Completed".to_string();
                let mut description_lines =
                    vec![format!("**{}**", notification_event.task_name)];

                if let Some(duration_value) = notification_event.details.get("duration") {
                    if let Some(cost_value) = notification_event.details.get("cost") {
                        description_lines
                            .push(format!("Duration: {} | Cost: {}", duration_value, cost_value));
                    } else {
                        description_lines.push(format!("Duration: {}", duration_value));
                    }
                }

                if let Some(pull_request_url) = notification_event.details.get("pr_url") {
                    description_lines.push(format!("PR: {}", pull_request_url));
                }

                (
                    embed_title,
                    description_lines.join("\n"),
                    DISCORD_COLOR_GREEN,
                )
            }
            NotificationEventType::TaskFailed => {
                let embed_title = "Task Failed".to_string();
                let error_summary = notification_event
                    .details
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| notification_event.summary.clone());
                let embed_description = format!(
                    "**{}**\nError: {}",
                    notification_event.task_name, error_summary
                );
                (embed_title, embed_description, DISCORD_COLOR_RED)
            }
            NotificationEventType::TaskStarted => {
                let embed_title = "Task Started".to_string();
                let embed_description = format!("**{}**", notification_event.task_name);
                (embed_title, embed_description, DISCORD_COLOR_BLUE)
            }
            NotificationEventType::TriggerFired => {
                let embed_title = "Trigger Fired".to_string();
                let trigger_name = notification_event
                    .details
                    .get("trigger_name")
                    .cloned()
                    .unwrap_or_else(|| notification_event.task_name.clone());
                let embed_description = format!("**{}**", trigger_name);
                (embed_title, embed_description, DISCORD_COLOR_BLUE)
            }
            NotificationEventType::DailyDigest => {
                let embed_title = "Daily Digest".to_string();
                let embed_description = notification_event.summary.clone();
                (embed_title, embed_description, DISCORD_COLOR_BLUE)
            }
            NotificationEventType::PullRequestCreated => {
                let embed_title = "Pull Request Created".to_string();
                let pull_request_url = notification_event
                    .details
                    .get("pr_url")
                    .cloned()
                    .unwrap_or_default();
                let embed_description = format!(
                    "**{}**\n{}",
                    notification_event.task_name, pull_request_url
                );
                (embed_title, embed_description, DISCORD_COLOR_GREEN)
            }
        }
    }
}

#[async_trait]
impl NotificationChannel for DiscordNotificationChannel {
    async fn send(&self, notification_event: &NotificationEvent) -> Result<(), String> {
        let discord_payload = Self::build_discord_embeds_payload(notification_event);

        let http_response = self
            .http_client
            .post(&self.webhook_url)
            .json(&discord_payload)
            .send()
            .await
            .map_err(|request_error| {
                format!(
                    "failed to send Discord webhook request to {}: {}",
                    self.webhook_url, request_error
                )
            })?;

        let response_status = http_response.status();
        if !response_status.is_success() {
            let response_body_text = http_response
                .text()
                .await
                .unwrap_or_else(|_| "unable to read response body".to_string());
            return Err(format!(
                "Discord webhook returned non-success status {}: {}",
                response_status, response_body_text
            ));
        }

        Ok(())
    }

    fn channel_name(&self) -> &str {
        &self.channel_name
    }

    fn subscribed_events(&self) -> &[NotificationEventType] {
        &self.subscribed_event_types
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use chrono::{DateTime, Utc};

    fn create_test_notification_event_with_type_and_details(
        event_type: NotificationEventType,
        details: HashMap<String, String>,
    ) -> NotificationEvent {
        NotificationEvent {
            event_type,
            task_name: "fix-login-bug".to_string(),
            task_id: "task-001".to_string(),
            summary: "Fix login bug completed".to_string(),
            details,
            timestamp: DateTime::parse_from_rfc3339("2026-03-15T10:30:00Z")
                .unwrap()
                .with_timezone(&Utc),
        }
    }

    #[test]
    fn discord_payload_for_task_completed_includes_duration_and_cost() {
        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "4m 32s".to_string());
        completed_task_details.insert("cost".to_string(), "$0.14".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        let embeds = discord_payload["embeds"].as_array().unwrap();
        assert_eq!(embeds.len(), 1);

        let embed = &embeds[0];
        assert_eq!(embed["title"], "Task Completed");
        assert_eq!(embed["color"], DISCORD_COLOR_GREEN);

        let description = embed["description"].as_str().unwrap();
        assert!(description.contains("**fix-login-bug**"));
        assert!(description.contains("Duration: 4m 32s"));
        assert!(description.contains("Cost: $0.14"));
    }

    #[test]
    fn discord_payload_for_task_completed_with_pull_request_link() {
        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "2m 10s".to_string());
        completed_task_details.insert("cost".to_string(), "$0.08".to_string());
        completed_task_details
            .insert("pr_url".to_string(), "https://github.com/org/repo/pull/42".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        let description = discord_payload["embeds"][0]["description"]
            .as_str()
            .unwrap();
        assert!(description.contains("PR: https://github.com/org/repo/pull/42"));
    }

    #[test]
    fn discord_payload_for_task_failed_includes_error_summary() {
        let mut failed_task_details = HashMap::new();
        failed_task_details.insert("error".to_string(), "Compilation failed on line 42".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            failed_task_details,
        );

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        let embed = &discord_payload["embeds"][0];
        assert_eq!(embed["title"], "Task Failed");
        assert_eq!(embed["color"], DISCORD_COLOR_RED);

        let description = embed["description"].as_str().unwrap();
        assert!(description.contains("**fix-login-bug**"));
        assert!(description.contains("Error: Compilation failed on line 42"));
    }

    #[test]
    fn discord_payload_for_task_failed_falls_back_to_summary_when_no_error_detail() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            HashMap::new(),
        );

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        let description = discord_payload["embeds"][0]["description"]
            .as_str()
            .unwrap();
        assert!(description.contains("Error: Fix login bug completed"));
    }

    #[test]
    fn discord_payload_for_task_started_includes_task_name() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskStarted,
            HashMap::new(),
        );

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        let embed = &discord_payload["embeds"][0];
        assert_eq!(embed["title"], "Task Started");
        assert_eq!(embed["color"], DISCORD_COLOR_BLUE);

        let description = embed["description"].as_str().unwrap();
        assert!(description.contains("**fix-login-bug**"));
    }

    #[test]
    fn discord_payload_for_trigger_fired_includes_trigger_name() {
        let mut trigger_details = HashMap::new();
        trigger_details.insert("trigger_name".to_string(), "on-push-to-main".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TriggerFired,
            trigger_details,
        );

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        let embed = &discord_payload["embeds"][0];
        assert_eq!(embed["title"], "Trigger Fired");
        assert_eq!(embed["color"], DISCORD_COLOR_BLUE);

        let description = embed["description"].as_str().unwrap();
        assert!(description.contains("**on-push-to-main**"));
    }

    #[test]
    fn discord_payload_for_daily_digest_includes_summary() {
        let notification_event = NotificationEvent {
            event_type: NotificationEventType::DailyDigest,
            task_name: "daily-digest".to_string(),
            task_id: "digest-001".to_string(),
            summary: "Tasks: 5 completed, 1 failed | Total cost: $1.23".to_string(),
            details: HashMap::new(),
            timestamp: DateTime::parse_from_rfc3339("2026-03-15T23:59:00Z")
                .unwrap()
                .with_timezone(&Utc),
        };

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        let embed = &discord_payload["embeds"][0];
        assert_eq!(embed["title"], "Daily Digest");
        assert_eq!(embed["color"], DISCORD_COLOR_BLUE);

        let description = embed["description"].as_str().unwrap();
        assert!(description.contains("Tasks: 5 completed, 1 failed"));
        assert!(description.contains("Total cost: $1.23"));
    }

    #[test]
    fn discord_payload_for_pull_request_created() {
        let mut pull_request_details = HashMap::new();
        pull_request_details
            .insert("pr_url".to_string(), "https://github.com/org/repo/pull/99".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::PullRequestCreated,
            pull_request_details,
        );

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        let embed = &discord_payload["embeds"][0];
        assert_eq!(embed["title"], "Pull Request Created");
        assert_eq!(embed["color"], DISCORD_COLOR_GREEN);

        let description = embed["description"].as_str().unwrap();
        assert!(description.contains("**fix-login-bug**"));
        assert!(description.contains("https://github.com/org/repo/pull/99"));
    }

    #[test]
    fn discord_payload_has_correct_json_structure() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskStarted,
            HashMap::new(),
        );

        let discord_payload =
            DiscordNotificationChannel::build_discord_embeds_payload(&notification_event);

        assert!(discord_payload["embeds"].is_array());
        let embeds = discord_payload["embeds"].as_array().unwrap();
        assert_eq!(embeds.len(), 1);
        assert!(embeds[0]["title"].is_string());
        assert!(embeds[0]["description"].is_string());
        assert!(embeds[0]["color"].is_number());
    }

    #[test]
    fn discord_channel_returns_correct_name_and_subscribed_events() {
        let subscribed_events = vec![
            NotificationEventType::TaskCompleted,
            NotificationEventType::TaskFailed,
            NotificationEventType::DailyDigest,
        ];

        let discord_channel = DiscordNotificationChannel::new(
            "dev-notifications".to_string(),
            "https://discord.com/api/webhooks/123/abc".to_string(),
            subscribed_events.clone(),
        );

        assert_eq!(discord_channel.channel_name(), "dev-notifications");
        assert_eq!(discord_channel.subscribed_events().len(), 3);
        assert_eq!(
            discord_channel.subscribed_events()[0],
            NotificationEventType::TaskCompleted
        );
        assert_eq!(
            discord_channel.subscribed_events()[1],
            NotificationEventType::TaskFailed
        );
        assert_eq!(
            discord_channel.subscribed_events()[2],
            NotificationEventType::DailyDigest
        );
    }

    #[test]
    fn discord_color_constants_have_expected_values() {
        assert_eq!(DISCORD_COLOR_GREEN, 3_066_993);
        assert_eq!(DISCORD_COLOR_RED, 15_158_332);
        assert_eq!(DISCORD_COLOR_BLUE, 3_447_003);
    }
}
