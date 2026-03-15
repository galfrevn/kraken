use async_trait::async_trait;
use std::process::Command;

use super::types::{NotificationChannel, NotificationEvent, NotificationEventType};

pub struct SystemNotificationChannel {
    channel_name: String,
    subscribed_event_types: Vec<NotificationEventType>,
}

impl SystemNotificationChannel {
    pub fn new(
        channel_name: String,
        subscribed_event_types: Vec<NotificationEventType>,
    ) -> Self {
        SystemNotificationChannel {
            channel_name,
            subscribed_event_types,
        }
    }

    fn format_notification_title_for_event(notification_event: &NotificationEvent) -> String {
        match notification_event.event_type {
            NotificationEventType::TaskStarted => "Kraken: Task Started".to_string(),
            NotificationEventType::TaskCompleted => "Kraken: Task Completed".to_string(),
            NotificationEventType::TaskFailed => "Kraken: Task Failed".to_string(),
            NotificationEventType::PullRequestCreated => {
                "Kraken: Pull Request Created".to_string()
            }
            NotificationEventType::TriggerFired => "Kraken: Trigger Fired".to_string(),
            NotificationEventType::DailyDigest => "Kraken: Daily Digest".to_string(),
            NotificationEventType::CostWarningExceeded => {
                "Kraken: Cost Warning Exceeded".to_string()
            }
        }
    }

    fn format_notification_body_for_event(notification_event: &NotificationEvent) -> String {
        match notification_event.event_type {
            NotificationEventType::TaskCompleted => {
                let mut body_parts = vec![notification_event.task_name.clone()];
                if let Some(duration_value) = notification_event.details.get("duration") {
                    body_parts.push(format!("Duration: {}", duration_value));
                }
                body_parts.join(" - ")
            }
            NotificationEventType::TaskFailed => {
                let error_summary = notification_event
                    .details
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| notification_event.summary.clone());
                format!("{} - {}", notification_event.task_name, error_summary)
            }
            NotificationEventType::DailyDigest => notification_event.summary.clone(),
            _ => notification_event.task_name.clone(),
        }
    }

    pub fn build_platform_notification_command(
        notification_title: &str,
        notification_body: &str,
    ) -> Option<Command> {
        if cfg!(target_os = "macos") {
            let mut macos_command = Command::new("osascript");
            let applescript_notification = format!(
                "display notification \"{}\" with title \"{}\"",
                Self::escape_for_applescript(notification_body),
                Self::escape_for_applescript(notification_title),
            );
            macos_command.arg("-e").arg(applescript_notification);
            Some(macos_command)
        } else if cfg!(target_os = "linux") {
            let mut linux_command = Command::new("notify-send");
            linux_command
                .arg(notification_title)
                .arg(notification_body);
            Some(linux_command)
        } else if cfg!(target_os = "windows") {
            let mut windows_command = Command::new("powershell");
            let powershell_script = format!(
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; \
                 $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \
                 $textNodes = $template.GetElementsByTagName('text'); \
                 $textNodes.Item(0).AppendChild($template.CreateTextNode('{}')) > $null; \
                 $textNodes.Item(1).AppendChild($template.CreateTextNode('{}')) > $null; \
                 $toast = [Windows.UI.Notifications.ToastNotification]::new($template); \
                 [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Kraken').Show($toast)",
                Self::escape_for_powershell(notification_title),
                Self::escape_for_powershell(notification_body),
            );
            windows_command
                .arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-Command")
                .arg(powershell_script);
            Some(windows_command)
        } else {
            None
        }
    }

    fn escape_for_applescript(input_text: &str) -> String {
        input_text.replace('\\', "\\\\").replace('"', "\\\"")
    }

    fn escape_for_powershell(input_text: &str) -> String {
        input_text.replace('\'', "''")
    }
}

#[async_trait]
impl NotificationChannel for SystemNotificationChannel {
    async fn send(&self, notification_event: &NotificationEvent) -> Result<(), String> {
        let notification_title =
            Self::format_notification_title_for_event(notification_event);
        let notification_body =
            Self::format_notification_body_for_event(notification_event);

        let mut platform_command =
            Self::build_platform_notification_command(&notification_title, &notification_body)
                .ok_or_else(|| {
                    "unsupported platform for desktop notifications".to_string()
                })?;

        let command_output = platform_command.output().map_err(|spawn_error| {
            format!(
                "failed to spawn desktop notification command: {}",
                spawn_error
            )
        })?;

        if !command_output.status.success() {
            let stderr_output =
                String::from_utf8_lossy(&command_output.stderr).to_string();
            return Err(format!(
                "desktop notification command exited with status {}: {}",
                command_output.status, stderr_output
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
    fn notification_title_for_task_completed() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            HashMap::new(),
        );

        let title =
            SystemNotificationChannel::format_notification_title_for_event(&notification_event);

        assert_eq!(title, "Kraken: Task Completed");
    }

    #[test]
    fn notification_title_for_task_failed() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            HashMap::new(),
        );

        let title =
            SystemNotificationChannel::format_notification_title_for_event(&notification_event);

        assert_eq!(title, "Kraken: Task Failed");
    }

    #[test]
    fn notification_title_for_task_started() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskStarted,
            HashMap::new(),
        );

        let title =
            SystemNotificationChannel::format_notification_title_for_event(&notification_event);

        assert_eq!(title, "Kraken: Task Started");
    }

    #[test]
    fn notification_title_for_pull_request_created() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::PullRequestCreated,
            HashMap::new(),
        );

        let title =
            SystemNotificationChannel::format_notification_title_for_event(&notification_event);

        assert_eq!(title, "Kraken: Pull Request Created");
    }

    #[test]
    fn notification_title_for_trigger_fired() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TriggerFired,
            HashMap::new(),
        );

        let title =
            SystemNotificationChannel::format_notification_title_for_event(&notification_event);

        assert_eq!(title, "Kraken: Trigger Fired");
    }

    #[test]
    fn notification_title_for_daily_digest() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::DailyDigest,
            HashMap::new(),
        );

        let title =
            SystemNotificationChannel::format_notification_title_for_event(&notification_event);

        assert_eq!(title, "Kraken: Daily Digest");
    }

    #[test]
    fn notification_body_for_task_completed_includes_duration() {
        let mut completed_task_details = HashMap::new();
        completed_task_details.insert("duration".to_string(), "4m 32s".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            completed_task_details,
        );

        let body =
            SystemNotificationChannel::format_notification_body_for_event(&notification_event);

        assert_eq!(body, "fix-login-bug - Duration: 4m 32s");
    }

    #[test]
    fn notification_body_for_task_completed_without_duration() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskCompleted,
            HashMap::new(),
        );

        let body =
            SystemNotificationChannel::format_notification_body_for_event(&notification_event);

        assert_eq!(body, "fix-login-bug");
    }

    #[test]
    fn notification_body_for_task_failed_includes_error() {
        let mut failed_task_details = HashMap::new();
        failed_task_details
            .insert("error".to_string(), "Compilation failed on line 42".to_string());

        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            failed_task_details,
        );

        let body =
            SystemNotificationChannel::format_notification_body_for_event(&notification_event);

        assert_eq!(
            body,
            "fix-login-bug - Compilation failed on line 42"
        );
    }

    #[test]
    fn notification_body_for_task_failed_falls_back_to_summary() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskFailed,
            HashMap::new(),
        );

        let body =
            SystemNotificationChannel::format_notification_body_for_event(&notification_event);

        assert_eq!(body, "fix-login-bug - Fix login bug completed");
    }

    #[test]
    fn notification_body_for_daily_digest_uses_summary() {
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

        let body =
            SystemNotificationChannel::format_notification_body_for_event(&notification_event);

        assert_eq!(
            body,
            "Tasks: 5 completed, 1 failed | Total cost: $1.23"
        );
    }

    #[test]
    fn notification_body_for_task_started_uses_task_name() {
        let notification_event = create_test_notification_event_with_type_and_details(
            NotificationEventType::TaskStarted,
            HashMap::new(),
        );

        let body =
            SystemNotificationChannel::format_notification_body_for_event(&notification_event);

        assert_eq!(body, "fix-login-bug");
    }

    #[test]
    fn platform_notification_command_is_constructed_for_current_os() {
        let command_result = SystemNotificationChannel::build_platform_notification_command(
            "Test Title",
            "Test Body",
        );

        assert!(
            command_result.is_some(),
            "should produce a command for the current platform"
        );
    }

    #[test]
    fn system_channel_returns_correct_name_and_subscribed_events() {
        let subscribed_events = vec![
            NotificationEventType::TaskCompleted,
            NotificationEventType::TaskFailed,
        ];

        let system_channel = SystemNotificationChannel::new(
            "desktop-alerts".to_string(),
            subscribed_events.clone(),
        );

        assert_eq!(system_channel.channel_name(), "desktop-alerts");
        assert_eq!(system_channel.subscribed_events().len(), 2);
        assert_eq!(
            system_channel.subscribed_events()[0],
            NotificationEventType::TaskCompleted
        );
        assert_eq!(
            system_channel.subscribed_events()[1],
            NotificationEventType::TaskFailed
        );
    }

    #[test]
    fn applescript_escape_handles_quotes_and_backslashes() {
        let escaped =
            SystemNotificationChannel::escape_for_applescript("He said \"hello\\world\"");

        assert_eq!(escaped, "He said \\\"hello\\\\world\\\"");
    }

    #[test]
    fn powershell_escape_handles_single_quotes() {
        let escaped =
            SystemNotificationChannel::escape_for_powershell("it's a test with 'quotes'");

        assert_eq!(escaped, "it''s a test with ''quotes''");
    }
}
