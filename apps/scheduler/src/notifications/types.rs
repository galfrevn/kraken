use std::collections::HashMap;
use std::fmt;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotificationEventType {
    TaskStarted,
    TaskCompleted,
    TaskFailed,
    PullRequestCreated,
    TriggerFired,
    DailyDigest,
}

impl fmt::Display for NotificationEventType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NotificationEventType::TaskStarted => write!(formatter, "TaskStarted"),
            NotificationEventType::TaskCompleted => write!(formatter, "TaskCompleted"),
            NotificationEventType::TaskFailed => write!(formatter, "TaskFailed"),
            NotificationEventType::PullRequestCreated => write!(formatter, "PullRequestCreated"),
            NotificationEventType::TriggerFired => write!(formatter, "TriggerFired"),
            NotificationEventType::DailyDigest => write!(formatter, "DailyDigest"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct NotificationEvent {
    pub event_type: NotificationEventType,
    pub task_name: String,
    pub task_id: String,
    pub summary: String,
    pub details: HashMap<String, String>,
    pub timestamp: DateTime<Utc>,
}

impl NotificationEvent {
    pub fn format_as_plain_text(&self) -> String {
        let formatted_timestamp = self.timestamp.format("%Y-%m-%d %H:%M:%S UTC");
        let mut formatted_output = format!(
            "[{}] {} — {}\nTask: {} ({})\n",
            formatted_timestamp,
            self.event_type,
            self.summary,
            self.task_name,
            self.task_id,
        );

        if !self.details.is_empty() {
            let mut sorted_detail_keys: Vec<&String> = self.details.keys().collect();
            sorted_detail_keys.sort();
            for detail_key in sorted_detail_keys {
                let detail_value = &self.details[detail_key];
                formatted_output.push_str(&format!("  {}: {}\n", detail_key, detail_value));
            }
        }

        formatted_output
    }
}

#[async_trait]
pub trait NotificationChannel: Send + Sync {
    async fn send(&self, event: &NotificationEvent) -> Result<(), String>;
    fn channel_name(&self) -> &str;
    fn subscribed_events(&self) -> &[NotificationEventType];
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_notification_event() -> NotificationEvent {
        let mut test_details = HashMap::new();
        test_details.insert("duration".to_string(), "45s".to_string());
        test_details.insert("cost".to_string(), "$0.12".to_string());

        NotificationEvent {
            event_type: NotificationEventType::TaskCompleted,
            task_name: "refactor-auth-module".to_string(),
            task_id: "task-abc-123".to_string(),
            summary: "Auth module refactoring completed successfully".to_string(),
            details: test_details,
            timestamp: DateTime::parse_from_rfc3339("2026-03-15T10:30:00Z")
                .unwrap()
                .with_timezone(&Utc),
        }
    }

    #[test]
    fn format_as_plain_text_includes_all_fields() {
        let notification_event = create_test_notification_event();
        let formatted_text = notification_event.format_as_plain_text();

        assert!(formatted_text.contains("2026-03-15 10:30:00 UTC"));
        assert!(formatted_text.contains("TaskCompleted"));
        assert!(formatted_text.contains("Auth module refactoring completed successfully"));
        assert!(formatted_text.contains("refactor-auth-module"));
        assert!(formatted_text.contains("task-abc-123"));
        assert!(formatted_text.contains("duration: 45s"));
        assert!(formatted_text.contains("cost: $0.12"));
    }

    #[test]
    fn format_as_plain_text_with_empty_details() {
        let notification_event = NotificationEvent {
            event_type: NotificationEventType::TaskStarted,
            task_name: "lint-codebase".to_string(),
            task_id: "task-xyz-789".to_string(),
            summary: "Linting codebase".to_string(),
            details: HashMap::new(),
            timestamp: DateTime::parse_from_rfc3339("2026-03-15T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        };

        let formatted_text = notification_event.format_as_plain_text();

        assert!(formatted_text.contains("TaskStarted"));
        assert!(formatted_text.contains("lint-codebase"));
        assert!(!formatted_text.contains("  "));
    }

    #[test]
    fn notification_event_type_equality() {
        assert_eq!(NotificationEventType::TaskStarted, NotificationEventType::TaskStarted);
        assert_eq!(NotificationEventType::TaskFailed, NotificationEventType::TaskFailed);
        assert_ne!(NotificationEventType::TaskStarted, NotificationEventType::TaskCompleted);
        assert_ne!(NotificationEventType::DailyDigest, NotificationEventType::TriggerFired);
    }

    #[test]
    fn notification_event_type_display() {
        assert_eq!(format!("{}", NotificationEventType::TaskStarted), "TaskStarted");
        assert_eq!(format!("{}", NotificationEventType::TaskCompleted), "TaskCompleted");
        assert_eq!(format!("{}", NotificationEventType::TaskFailed), "TaskFailed");
        assert_eq!(format!("{}", NotificationEventType::PullRequestCreated), "PullRequestCreated");
        assert_eq!(format!("{}", NotificationEventType::TriggerFired), "TriggerFired");
        assert_eq!(format!("{}", NotificationEventType::DailyDigest), "DailyDigest");
    }
}
