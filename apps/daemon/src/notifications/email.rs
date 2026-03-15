use async_trait::async_trait;
use serde_json::{json, Value};

use super::types::{NotificationChannel, NotificationEvent, NotificationEventType};

const RESEND_API_ENDPOINT: &str = "https://api.resend.com/emails";

pub struct EmailNotificationChannel {
    channel_name: String,
    resend_api_key: String,
    from_address: String,
    to_address: String,
    subscribed_event_types: Vec<NotificationEventType>,
    http_client: reqwest::Client,
}

impl EmailNotificationChannel {
    pub fn new(
        channel_name: String,
        resend_api_key: String,
        from_address: String,
        to_address: String,
        subscribed_event_types: Vec<NotificationEventType>,
    ) -> Self {
        EmailNotificationChannel {
            channel_name,
            resend_api_key,
            from_address,
            to_address,
            subscribed_event_types,
            http_client: reqwest::Client::new(),
        }
    }

    pub fn format_email_subject_for_event(notification_event: &NotificationEvent) -> String {
        match notification_event.event_type {
            NotificationEventType::TaskStarted => {
                format!("Kraken: Task Started - {}", notification_event.task_name)
            }
            NotificationEventType::TaskCompleted => {
                format!("Kraken: Task Completed - {}", notification_event.task_name)
            }
            NotificationEventType::TaskFailed => {
                format!("Kraken: Task Failed - {}", notification_event.task_name)
            }
            NotificationEventType::PullRequestCreated => {
                format!(
                    "Kraken: Pull Request Created - {}",
                    notification_event.task_name
                )
            }
            NotificationEventType::TriggerFired => {
                let trigger_name = notification_event
                    .details
                    .get("trigger_name")
                    .cloned()
                    .unwrap_or_else(|| notification_event.task_name.clone());
                format!("Kraken: Trigger Fired - {}", trigger_name)
            }
            NotificationEventType::DailyDigest => "Kraken: Daily Digest".to_string(),
            NotificationEventType::CostWarningExceeded => {
                "Kraken: Cost Warning Exceeded".to_string()
            }
        }
    }

    pub fn format_email_html_body_for_event(notification_event: &NotificationEvent) -> String {
        match notification_event.event_type {
            NotificationEventType::TaskCompleted => {
                let mut html_sections = vec![format!(
                    "<h2>Task Completed</h2><p><b>{}</b></p>",
                    notification_event.task_name
                )];

                if let Some(duration_value) = notification_event.details.get("duration") {
                    html_sections.push(format!("<p>Duration: {}</p>", duration_value));
                }

                if let Some(cost_value) = notification_event.details.get("cost") {
                    html_sections.push(format!("<p>Cost: {}</p>", cost_value));
                }

                if let Some(pull_request_url) = notification_event.details.get("pr_url") {
                    html_sections.push(format!(
                        "<p>PR: <a href=\"{}\">{}</a></p>",
                        pull_request_url, pull_request_url
                    ));
                }

                html_sections.join("")
            }
            NotificationEventType::TaskFailed => {
                let error_summary = notification_event
                    .details
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| notification_event.summary.clone());
                format!(
                    "<h2>Task Failed</h2><p><b>{}</b></p><p>Error: {}</p>",
                    notification_event.task_name, error_summary
                )
            }
            NotificationEventType::TaskStarted => {
                format!(
                    "<h2>Task Started</h2><p><b>{}</b></p>",
                    notification_event.task_name
                )
            }
            NotificationEventType::TriggerFired => {
                let trigger_name = notification_event
                    .details
                    .get("trigger_name")
                    .cloned()
                    .unwrap_or_else(|| notification_event.task_name.clone());
                format!("<h2>Trigger Fired</h2><p><b>{}</b></p>", trigger_name)
            }
            NotificationEventType::DailyDigest => {
                let mut html_sections = vec!["<h2>Daily Digest</h2>".to_string()];

                let mut sorted_detail_keys: Vec<&String> =
                    notification_event.details.keys().collect();
                sorted_detail_keys.sort();

                for detail_key in sorted_detail_keys {
                    let detail_value = &notification_event.details[detail_key];
                    html_sections
                        .push(format!("<p><b>{}:</b> {}</p>", detail_key, detail_value));
                }

                if notification_event.details.is_empty() {
                    html_sections.push(format!("<p>{}</p>", notification_event.summary));
                }

                html_sections.join("")
            }
            NotificationEventType::PullRequestCreated => {
                let pull_request_url = notification_event
                    .details
                    .get("pr_url")
                    .cloned()
                    .unwrap_or_default();
                format!(
                    "<h2>Pull Request Created</h2><p><b>{}</b></p><p><a href=\"{}\">{}</a></p>",
                    notification_event.task_name, pull_request_url, pull_request_url
                )
            }
            NotificationEventType::CostWarningExceeded => {
                format!(
                    "<h2>Cost Warning Exceeded</h2><p>{}</p>",
                    notification_event.summary
                )
            }
        }
    }

    pub fn build_resend_api_request_body(
        &self,
        notification_event: &NotificationEvent,
    ) -> Value {
        let email_subject =
            Self::format_email_subject_for_event(notification_event);
        let email_html_body =
            Self::format_email_html_body_for_event(notification_event);
        let email_plain_text_body = notification_event.format_as_plain_text();

        json!({
            "from": self.from_address,
            "to": [self.to_address],
            "subject": email_subject,
            "html": email_html_body,
            "text": email_plain_text_body
        })
    }
}

#[async_trait]
impl NotificationChannel for EmailNotificationChannel {
    async fn send(&self, notification_event: &NotificationEvent) -> Result<(), String> {
        let resend_request_body = self.build_resend_api_request_body(notification_event);

        let http_response = self
            .http_client
            .post(RESEND_API_ENDPOINT)
            .header("Authorization", format!("Bearer {}", self.resend_api_key))
            .json(&resend_request_body)
            .send()
            .await
            .map_err(|request_error| {
                format!(
                    "failed to send email via Resend API: {}",
                    request_error
                )
            })?;

        let response_status = http_response.status();
        if !response_status.is_success() {
            let response_body_text = http_response
                .text()
                .await
                .unwrap_or_else(|_| "unable to read response body".to_string());
            return Err(format!(
                "Resend API returned non-success status {}: {}",
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

    fn create_test_email_channel() -> EmailNotificationChannel {
        EmailNotificationChannel::new(
            "email-notifications".to_string(),
            "re_test_api_key_12345".to_string(),
            "Kraken <kraken@yourdomain.com>".to_string(),
            "dev@company.com".to_string(),
            vec![
                NotificationEventType::TaskCompleted,
                NotificationEventType::TaskFailed,
                NotificationEventType::DailyDigest,
            ],
        )
    }

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
    fn email_subject_for_task_completed_includes_task_name() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            HashMap::new(),
        );

        let subject = EmailNotificationChannel::format_email_subject_for_event(&notification_event);

        assert_eq!(subject, "Kraken: Task Completed - fix-login-bug");
    }

    #[test]
    fn email_subject_for_task_failed_includes_task_name() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            HashMap::new(),
        );

        let subject = EmailNotificationChannel::format_email_subject_for_event(&notification_event);

        assert_eq!(subject, "Kraken: Task Failed - fix-login-bug");
    }

    #[test]
    fn email_subject_for_task_started_includes_task_name() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskStarted,
            HashMap::new(),
        );

        let subject = EmailNotificationChannel::format_email_subject_for_event(&notification_event);

        assert_eq!(subject, "Kraken: Task Started - fix-login-bug");
    }

    #[test]
    fn email_subject_for_pull_request_created_includes_task_name() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::PullRequestCreated,
            HashMap::new(),
        );

        let subject = EmailNotificationChannel::format_email_subject_for_event(&notification_event);

        assert_eq!(subject, "Kraken: Pull Request Created - fix-login-bug");
    }

    #[test]
    fn email_subject_for_trigger_fired_uses_trigger_name_from_details() {
        let mut trigger_details = HashMap::new();
        trigger_details.insert("trigger_name".to_string(), "on-push-to-main".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TriggerFired,
            trigger_details,
        );

        let subject = EmailNotificationChannel::format_email_subject_for_event(&notification_event);

        assert_eq!(subject, "Kraken: Trigger Fired - on-push-to-main");
    }

    #[test]
    fn email_subject_for_trigger_fired_falls_back_to_task_name() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TriggerFired,
            HashMap::new(),
        );

        let subject = EmailNotificationChannel::format_email_subject_for_event(&notification_event);

        assert_eq!(subject, "Kraken: Trigger Fired - fix-login-bug");
    }

    #[test]
    fn email_subject_for_daily_digest_has_no_task_name() {
        let notification_event = NotificationEvent {
            event_type: NotificationEventType::DailyDigest,
            task_name: "daily-digest".to_string(),
            task_id: "digest-001".to_string(),
            summary: "Tasks: 5 completed, 1 failed".to_string(),
            details: HashMap::new(),
            timestamp: DateTime::parse_from_rfc3339("2026-03-15T23:59:00Z")
                .unwrap()
                .with_timezone(&Utc),
        };

        let subject = EmailNotificationChannel::format_email_subject_for_event(&notification_event);

        assert_eq!(subject, "Kraken: Daily Digest");
    }

    #[test]
    fn email_html_body_for_task_completed_includes_duration_and_cost() {
        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "4m 32s".to_string());
        completed_task_details.insert("cost".to_string(), "$0.14".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let html_body =
            EmailNotificationChannel::format_email_html_body_for_event(&notification_event);

        assert!(html_body.contains("<h2>Task Completed</h2>"));
        assert!(html_body.contains("<b>fix-login-bug</b>"));
        assert!(html_body.contains("Duration: 4m 32s"));
        assert!(html_body.contains("Cost: $0.14"));
    }

    #[test]
    fn email_html_body_for_task_completed_includes_pull_request_link() {
        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "2m 10s".to_string());
        completed_task_details.insert(
            "pr_url".to_string(),
            "https://github.com/org/repo/pull/42".to_string(),
        );

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let html_body =
            EmailNotificationChannel::format_email_html_body_for_event(&notification_event);

        assert!(html_body.contains("https://github.com/org/repo/pull/42"));
        assert!(html_body.contains("<a href="));
    }

    #[test]
    fn email_html_body_for_task_failed_includes_error() {
        let mut failed_task_details = HashMap::new();
        failed_task_details
            .insert("error".to_string(), "Compilation failed on line 42".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            failed_task_details,
        );

        let html_body =
            EmailNotificationChannel::format_email_html_body_for_event(&notification_event);

        assert!(html_body.contains("<h2>Task Failed</h2>"));
        assert!(html_body.contains("<b>fix-login-bug</b>"));
        assert!(html_body.contains("Error: Compilation failed on line 42"));
    }

    #[test]
    fn email_html_body_for_task_failed_falls_back_to_summary() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            HashMap::new(),
        );

        let html_body =
            EmailNotificationChannel::format_email_html_body_for_event(&notification_event);

        assert!(html_body.contains("Error: Fix login bug completed"));
    }

    #[test]
    fn email_html_body_for_daily_digest_includes_summary() {
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

        let html_body =
            EmailNotificationChannel::format_email_html_body_for_event(&notification_event);

        assert!(html_body.contains("<h2>Daily Digest</h2>"));
        assert!(html_body.contains("Tasks: 5 completed, 1 failed"));
    }

    #[test]
    fn email_html_body_for_daily_digest_with_details_renders_each_detail() {
        let mut digest_details = HashMap::new();
        digest_details.insert("completed".to_string(), "5".to_string());
        digest_details.insert("failed".to_string(), "1".to_string());
        digest_details.insert("total_cost".to_string(), "$1.23".to_string());

        let notification_event = NotificationEvent {
            event_type: NotificationEventType::DailyDigest,
            task_name: "daily-digest".to_string(),
            task_id: "digest-001".to_string(),
            summary: "Daily summary".to_string(),
            details: digest_details,
            timestamp: DateTime::parse_from_rfc3339("2026-03-15T23:59:00Z")
                .unwrap()
                .with_timezone(&Utc),
        };

        let html_body =
            EmailNotificationChannel::format_email_html_body_for_event(&notification_event);

        assert!(html_body.contains("<b>completed:</b> 5"));
        assert!(html_body.contains("<b>failed:</b> 1"));
        assert!(html_body.contains("<b>total_cost:</b> $1.23"));
    }

    #[test]
    fn resend_api_request_body_has_correct_json_structure() {
        let email_channel = create_test_email_channel();

        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "4m 32s".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let request_body = email_channel.build_resend_api_request_body(&notification_event);

        assert_eq!(
            request_body["from"],
            "Kraken <kraken@yourdomain.com>"
        );

        let recipients = request_body["to"].as_array().unwrap();
        assert_eq!(recipients.len(), 1);
        assert_eq!(recipients[0], "dev@company.com");

        assert_eq!(
            request_body["subject"],
            "Kraken: Task Completed - fix-login-bug"
        );

        assert!(request_body["html"].as_str().unwrap().contains("<h2>Task Completed</h2>"));
        assert!(request_body["text"].as_str().unwrap().contains("TaskCompleted"));
    }

    #[test]
    fn resend_api_request_body_includes_plain_text_fallback() {
        let email_channel = create_test_email_channel();

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskStarted,
            HashMap::new(),
        );

        let request_body = email_channel.build_resend_api_request_body(&notification_event);

        let plain_text = request_body["text"].as_str().unwrap();
        assert!(plain_text.contains("TaskStarted"));
        assert!(plain_text.contains("fix-login-bug"));
        assert!(plain_text.contains("task-001"));
    }

    #[test]
    fn email_channel_returns_correct_name_and_subscribed_events() {
        let email_channel = create_test_email_channel();

        assert_eq!(email_channel.channel_name(), "email-notifications");
        assert_eq!(email_channel.subscribed_events().len(), 3);
        assert_eq!(
            email_channel.subscribed_events()[0],
            NotificationEventType::TaskCompleted
        );
        assert_eq!(
            email_channel.subscribed_events()[1],
            NotificationEventType::TaskFailed
        );
        assert_eq!(
            email_channel.subscribed_events()[2],
            NotificationEventType::DailyDigest
        );
    }
}
