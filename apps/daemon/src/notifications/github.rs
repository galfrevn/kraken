use async_trait::async_trait;
use serde_json::json;

use super::types::{NotificationChannel, NotificationEvent, NotificationEventType};

pub struct GitHubNotificationChannel {
    channel_name: String,
    github_api_token: String,
    repository_owner: String,
    repository_name: String,
    subscribed_event_types: Vec<NotificationEventType>,
    http_client: reqwest::Client,
}

impl GitHubNotificationChannel {
    pub fn new(
        channel_name: String,
        github_api_token: String,
        repository_owner: String,
        repository_name: String,
        subscribed_event_types: Vec<NotificationEventType>,
    ) -> Self {
        GitHubNotificationChannel {
            channel_name,
            github_api_token,
            repository_owner,
            repository_name,
            subscribed_event_types,
            http_client: reqwest::Client::new(),
        }
    }

    fn extract_pull_request_number_from_url(pull_request_url: &str) -> Option<u64> {
        let segments: Vec<&str> = pull_request_url.trim_end_matches('/').split('/').collect();
        if segments.len() >= 2 {
            let second_to_last_segment = segments[segments.len() - 2];
            let last_segment = segments[segments.len() - 1];
            if second_to_last_segment == "pull" {
                return last_segment.parse::<u64>().ok();
            }
        }
        None
    }

    fn format_comment_body_as_markdown(notification_event: &NotificationEvent) -> String {
        match notification_event.event_type {
            NotificationEventType::PullRequestCreated => {
                format!(
                    "## Pull Request Created\n\n**Task:** {}\n\n{}",
                    notification_event.task_name, notification_event.summary,
                )
            }
            NotificationEventType::TaskCompleted => {
                let mut markdown_lines = vec![
                    "## Task Completed".to_string(),
                    String::new(),
                    format!("**Task:** {}", notification_event.task_name),
                ];

                if let Some(duration_value) = notification_event.details.get("duration") {
                    markdown_lines.push(format!("**Duration:** {}", duration_value));
                }

                if let Some(cost_value) = notification_event.details.get("cost") {
                    markdown_lines.push(format!("**Cost:** {}", cost_value));
                }

                markdown_lines.join("\n")
            }
            NotificationEventType::TaskFailed => {
                let error_description = notification_event
                    .details
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| notification_event.summary.clone());

                format!(
                    "## Task Failed\n\n**Task:** {}\n**Error:** {}",
                    notification_event.task_name, error_description,
                )
            }
            _ => {
                format!(
                    "## {}\n\n**Task:** {}\n\n{}",
                    notification_event.event_type,
                    notification_event.task_name,
                    notification_event.summary,
                )
            }
        }
    }
}

#[async_trait]
impl NotificationChannel for GitHubNotificationChannel {
    async fn send(&self, notification_event: &NotificationEvent) -> Result<(), String> {
        let pull_request_url = match notification_event.details.get("pr_url") {
            Some(url) => url,
            None => return Ok(()),
        };

        let pull_request_number =
            match Self::extract_pull_request_number_from_url(pull_request_url) {
                Some(number) => number,
                None => return Ok(()),
            };

        let github_api_url = format!(
            "https://api.github.com/repos/{}/{}/issues/{}/comments",
            self.repository_owner, self.repository_name, pull_request_number,
        );

        let comment_body_markdown =
            Self::format_comment_body_as_markdown(notification_event);

        let request_payload = json!({
            "body": comment_body_markdown,
        });

        let http_response = self
            .http_client
            .post(&github_api_url)
            .header("Authorization", format!("Bearer {}", self.github_api_token))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "kraken-daemon")
            .json(&request_payload)
            .send()
            .await
            .map_err(|request_error| {
                format!(
                    "failed to send GitHub API request to {}: {}",
                    github_api_url, request_error,
                )
            })?;

        let response_status = http_response.status();
        if !response_status.is_success() {
            let response_body_text = http_response
                .text()
                .await
                .unwrap_or_else(|_| "unable to read response body".to_string());
            return Err(format!(
                "GitHub API returned non-success status {}: {}",
                response_status, response_body_text,
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
    fn extract_pull_request_number_from_standard_url() {
        let pull_request_number =
            GitHubNotificationChannel::extract_pull_request_number_from_url(
                "https://github.com/org/repo/pull/42",
            );
        assert_eq!(pull_request_number, Some(42));
    }

    #[test]
    fn extract_pull_request_number_from_url_with_trailing_slash() {
        let pull_request_number =
            GitHubNotificationChannel::extract_pull_request_number_from_url(
                "https://github.com/org/repo/pull/99/",
            );
        assert_eq!(pull_request_number, Some(99));
    }

    #[test]
    fn extract_pull_request_number_returns_none_for_non_pull_request_url() {
        let pull_request_number =
            GitHubNotificationChannel::extract_pull_request_number_from_url(
                "https://github.com/org/repo/issues/10",
            );
        assert_eq!(pull_request_number, None);
    }

    #[test]
    fn extract_pull_request_number_returns_none_for_invalid_number() {
        let pull_request_number =
            GitHubNotificationChannel::extract_pull_request_number_from_url(
                "https://github.com/org/repo/pull/abc",
            );
        assert_eq!(pull_request_number, None);
    }

    #[test]
    fn format_comment_body_for_pull_request_created() {
        let mut pull_request_details = HashMap::new();
        pull_request_details
            .insert("pr_url".to_string(), "https://github.com/org/repo/pull/42".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::PullRequestCreated,
            pull_request_details,
        );

        let comment_body =
            GitHubNotificationChannel::format_comment_body_as_markdown(&notification_event);

        assert!(comment_body.contains("## Pull Request Created"));
        assert!(comment_body.contains("**Task:** fix-login-bug"));
        assert!(comment_body.contains("Fix login bug completed"));
    }

    #[test]
    fn format_comment_body_for_task_completed_with_duration_and_cost() {
        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "4m 32s".to_string());
        completed_task_details.insert("cost".to_string(), "$0.14".to_string());
        completed_task_details
            .insert("pr_url".to_string(), "https://github.com/org/repo/pull/42".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let comment_body =
            GitHubNotificationChannel::format_comment_body_as_markdown(&notification_event);

        assert!(comment_body.contains("## Task Completed"));
        assert!(comment_body.contains("**Task:** fix-login-bug"));
        assert!(comment_body.contains("**Duration:** 4m 32s"));
        assert!(comment_body.contains("**Cost:** $0.14"));
    }

    #[test]
    fn format_comment_body_for_task_failed_with_error_detail() {
        let mut failed_task_details = HashMap::new();
        failed_task_details
            .insert("error".to_string(), "Compilation failed on line 42".to_string());
        failed_task_details
            .insert("pr_url".to_string(), "https://github.com/org/repo/pull/42".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            failed_task_details,
        );

        let comment_body =
            GitHubNotificationChannel::format_comment_body_as_markdown(&notification_event);

        assert!(comment_body.contains("## Task Failed"));
        assert!(comment_body.contains("**Task:** fix-login-bug"));
        assert!(comment_body.contains("**Error:** Compilation failed on line 42"));
    }

    #[test]
    fn format_comment_body_for_task_failed_falls_back_to_summary() {
        let mut failed_task_details = HashMap::new();
        failed_task_details
            .insert("pr_url".to_string(), "https://github.com/org/repo/pull/42".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            failed_task_details,
        );

        let comment_body =
            GitHubNotificationChannel::format_comment_body_as_markdown(&notification_event);

        assert!(comment_body.contains("**Error:** Fix login bug completed"));
    }

    #[test]
    fn send_returns_ok_when_no_pr_url_in_details() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            HashMap::new(),
        );

        let github_channel = GitHubNotificationChannel::new(
            "github-pr-comments".to_string(),
            "ghp_test_token".to_string(),
            "test-org".to_string(),
            "test-repo".to_string(),
            vec![NotificationEventType::TaskCompleted],
        );

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let send_result = runtime.block_on(github_channel.send(&notification_event));
        assert!(send_result.is_ok());
    }

    #[test]
    fn github_channel_returns_correct_name_and_subscribed_events() {
        let subscribed_events = vec![
            NotificationEventType::TaskCompleted,
            NotificationEventType::TaskFailed,
            NotificationEventType::PullRequestCreated,
        ];

        let github_channel = GitHubNotificationChannel::new(
            "github-pr-comments".to_string(),
            "ghp_test_token".to_string(),
            "test-org".to_string(),
            "test-repo".to_string(),
            subscribed_events.clone(),
        );

        assert_eq!(github_channel.channel_name(), "github-pr-comments");
        assert_eq!(github_channel.subscribed_events().len(), 3);
        assert_eq!(
            github_channel.subscribed_events()[0],
            NotificationEventType::TaskCompleted
        );
        assert_eq!(
            github_channel.subscribed_events()[1],
            NotificationEventType::TaskFailed
        );
        assert_eq!(
            github_channel.subscribed_events()[2],
            NotificationEventType::PullRequestCreated
        );
    }
}
