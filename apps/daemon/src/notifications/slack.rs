use async_trait::async_trait;
use serde_json::{Value, json};

use super::types::{NotificationChannel, NotificationEvent, NotificationEventType};

pub struct SlackNotificationChannel {
    channel_name: String,
    webhook_url: String,
    subscribed_event_types: Vec<NotificationEventType>,
    http_client: reqwest::Client,
}

impl SlackNotificationChannel {
    pub fn new(
        channel_name: String,
        webhook_url: String,
        subscribed_event_types: Vec<NotificationEventType>,
    ) -> Self {
        SlackNotificationChannel {
            channel_name,
            webhook_url,
            subscribed_event_types,
            http_client: reqwest::Client::new(),
        }
    }

    pub fn build_slack_blocks_payload(notification_event: &NotificationEvent) -> Value {
        let (header_text, body_markdown) =
            Self::format_header_and_body_for_event(notification_event);

        json!({
            "blocks": [
                {
                    "type": "header",
                    "text": {
                        "type": "plain_text",
                        "text": header_text
                    }
                },
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": body_markdown
                    }
                }
            ]
        })
    }

    fn format_header_and_body_for_event(
        notification_event: &NotificationEvent,
    ) -> (String, String) {
        match notification_event.event_type {
            NotificationEventType::TaskCompleted => {
                let header_text = ":white_check_mark: Task Completed".to_string();
                let mut body_lines = vec![format!("*{}*", notification_event.task_name)];

                if let Some(duration_value) = notification_event.details.get("duration") {
                    if let Some(cost_value) = notification_event.details.get("cost") {
                        body_lines.push(format!(
                            "Duration: {} | Cost: {}",
                            duration_value, cost_value
                        ));
                    } else {
                        body_lines.push(format!("Duration: {}", duration_value));
                    }
                }

                if let Some(pull_request_url) = notification_event.details.get("pr_url") {
                    body_lines.push(format!("PR: {}", pull_request_url));
                }

                (header_text, body_lines.join("\n"))
            }
            NotificationEventType::TaskFailed => {
                let header_text = ":x: Task Failed".to_string();
                let error_summary = notification_event
                    .details
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| notification_event.summary.clone());
                let body_markdown = format!(
                    "*{}*\nError: {}",
                    notification_event.task_name, error_summary
                );
                (header_text, body_markdown)
            }
            NotificationEventType::TaskStarted => {
                let header_text = ":information_source: Task Started".to_string();
                let body_markdown = format!("*{}*", notification_event.task_name);
                (header_text, body_markdown)
            }
            NotificationEventType::TriggerFired => {
                let header_text = ":information_source: Trigger Fired".to_string();
                let trigger_name = notification_event
                    .details
                    .get("trigger_name")
                    .cloned()
                    .unwrap_or_else(|| notification_event.task_name.clone());
                let body_markdown = format!("*{}*", trigger_name);
                (header_text, body_markdown)
            }
            NotificationEventType::DailyDigest => {
                let header_text = ":bar_chart: Daily Digest".to_string();
                let body_markdown = notification_event.summary.clone();
                (header_text, body_markdown)
            }
            NotificationEventType::PullRequestCreated => {
                let header_text = ":merged: Pull Request Created".to_string();
                let pull_request_url = notification_event
                    .details
                    .get("pr_url")
                    .cloned()
                    .unwrap_or_default();
                let body_markdown =
                    format!("*{}*\n{}", notification_event.task_name, pull_request_url);
                (header_text, body_markdown)
            }
            NotificationEventType::CostWarningExceeded => {
                let header_text = ":warning: Cost Warning".to_string();
                let body_markdown = notification_event.summary.clone();
                (header_text, body_markdown)
            }
        }
    }
}

#[async_trait]
impl NotificationChannel for SlackNotificationChannel {
    async fn send(&self, notification_event: &NotificationEvent) -> Result<(), String> {
        let slack_payload = Self::build_slack_blocks_payload(notification_event);

        let http_response = self
            .http_client
            .post(&self.webhook_url)
            .json(&slack_payload)
            .send()
            .await
            .map_err(|request_error| {
                format!(
                    "failed to send Slack webhook request to {}: {}",
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
                "Slack webhook returned non-success status {}: {}",
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
    fn slack_payload_for_task_completed_includes_duration_and_cost() {
        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "4m 32s".to_string());
        completed_task_details.insert("cost".to_string(), "$0.14".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        let blocks = slack_payload["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);

        let header_block = &blocks[0];
        assert_eq!(header_block["type"], "header");
        assert_eq!(header_block["text"]["type"], "plain_text");
        assert!(
            header_block["text"]["text"]
                .as_str()
                .unwrap()
                .contains("Task Completed")
        );

        let section_block = &blocks[1];
        assert_eq!(section_block["type"], "section");
        assert_eq!(section_block["text"]["type"], "mrkdwn");
        let section_text = section_block["text"]["text"].as_str().unwrap();
        assert!(section_text.contains("*fix-login-bug*"));
        assert!(section_text.contains("Duration: 4m 32s"));
        assert!(section_text.contains("Cost: $0.14"));
    }

    #[test]
    fn slack_payload_for_task_completed_with_pull_request_link() {
        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "2m 10s".to_string());
        completed_task_details.insert("cost".to_string(), "$0.08".to_string());
        completed_task_details.insert(
            "pr_url".to_string(),
            "https://github.com/org/repo/pull/42".to_string(),
        );

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        let section_text = slack_payload["blocks"][1]["text"]["text"].as_str().unwrap();
        assert!(section_text.contains("PR: https://github.com/org/repo/pull/42"));
    }

    #[test]
    fn slack_payload_for_task_failed_includes_error_summary() {
        let mut failed_task_details = HashMap::new();
        failed_task_details.insert(
            "error".to_string(),
            "Compilation failed on line 42".to_string(),
        );

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            failed_task_details,
        );

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        let header_text = slack_payload["blocks"][0]["text"]["text"].as_str().unwrap();
        assert!(header_text.contains("Task Failed"));

        let section_text = slack_payload["blocks"][1]["text"]["text"].as_str().unwrap();
        assert!(section_text.contains("*fix-login-bug*"));
        assert!(section_text.contains("Error: Compilation failed on line 42"));
    }

    #[test]
    fn slack_payload_for_task_failed_falls_back_to_summary_when_no_error_detail() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            HashMap::new(),
        );

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        let section_text = slack_payload["blocks"][1]["text"]["text"].as_str().unwrap();
        assert!(section_text.contains("Error: Fix login bug completed"));
    }

    #[test]
    fn slack_payload_for_task_started_includes_task_name() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskStarted,
            HashMap::new(),
        );

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        let header_text = slack_payload["blocks"][0]["text"]["text"].as_str().unwrap();
        assert!(header_text.contains("Task Started"));

        let section_text = slack_payload["blocks"][1]["text"]["text"].as_str().unwrap();
        assert!(section_text.contains("*fix-login-bug*"));
    }

    #[test]
    fn slack_payload_for_trigger_fired_includes_trigger_name() {
        let mut trigger_details = HashMap::new();
        trigger_details.insert("trigger_name".to_string(), "on-push-to-main".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TriggerFired,
            trigger_details,
        );

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        let header_text = slack_payload["blocks"][0]["text"]["text"].as_str().unwrap();
        assert!(header_text.contains("Trigger Fired"));

        let section_text = slack_payload["blocks"][1]["text"]["text"].as_str().unwrap();
        assert!(section_text.contains("*on-push-to-main*"));
    }

    #[test]
    fn slack_payload_for_daily_digest_includes_summary() {
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

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        let header_text = slack_payload["blocks"][0]["text"]["text"].as_str().unwrap();
        assert!(header_text.contains("Daily Digest"));

        let section_text = slack_payload["blocks"][1]["text"]["text"].as_str().unwrap();
        assert!(section_text.contains("Tasks: 5 completed, 1 failed"));
        assert!(section_text.contains("Total cost: $1.23"));
    }

    #[test]
    fn slack_payload_for_pull_request_created() {
        let mut pull_request_details = HashMap::new();
        pull_request_details.insert(
            "pr_url".to_string(),
            "https://github.com/org/repo/pull/99".to_string(),
        );

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::PullRequestCreated,
            pull_request_details,
        );

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        let header_text = slack_payload["blocks"][0]["text"]["text"].as_str().unwrap();
        assert!(header_text.contains("Pull Request Created"));

        let section_text = slack_payload["blocks"][1]["text"]["text"].as_str().unwrap();
        assert!(section_text.contains("*fix-login-bug*"));
        assert!(section_text.contains("https://github.com/org/repo/pull/99"));
    }

    #[test]
    fn slack_payload_has_correct_json_structure() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskStarted,
            HashMap::new(),
        );

        let slack_payload =
            SlackNotificationChannel::build_slack_blocks_payload(&notification_event);

        assert!(slack_payload["blocks"].is_array());
        let blocks = slack_payload["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "header");
        assert_eq!(blocks[0]["text"]["type"], "plain_text");
        assert_eq!(blocks[1]["type"], "section");
        assert_eq!(blocks[1]["text"]["type"], "mrkdwn");
    }

    #[test]
    fn slack_channel_returns_correct_name_and_subscribed_events() {
        let subscribed_events = vec![
            NotificationEventType::TaskCompleted,
            NotificationEventType::TaskFailed,
        ];

        let slack_channel = SlackNotificationChannel::new(
            "team-alerts".to_string(),
            "https://hooks.slack.com/services/T00/B00/xxx".to_string(),
            subscribed_events.clone(),
        );

        assert_eq!(slack_channel.channel_name(), "team-alerts");
        assert_eq!(slack_channel.subscribed_events().len(), 2);
        assert_eq!(
            slack_channel.subscribed_events()[0],
            NotificationEventType::TaskCompleted
        );
        assert_eq!(
            slack_channel.subscribed_events()[1],
            NotificationEventType::TaskFailed
        );
    }
}
