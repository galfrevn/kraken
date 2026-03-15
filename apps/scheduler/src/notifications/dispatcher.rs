use tracing::{error, info};

use super::types::{NotificationChannel, NotificationEvent};

pub struct NotificationDispatcher {
    registered_channels: Vec<Box<dyn NotificationChannel>>,
}

impl NotificationDispatcher {
    pub fn new() -> Self {
        NotificationDispatcher {
            registered_channels: Vec::new(),
        }
    }

    pub fn add_channel(&mut self, notification_channel: Box<dyn NotificationChannel>) {
        info!(
            channel_name = notification_channel.channel_name(),
            subscribed_event_count = notification_channel.subscribed_events().len(),
            "registered notification channel"
        );
        self.registered_channels.push(notification_channel);
    }

    pub async fn dispatch(&self, notification_event: NotificationEvent) {
        for registered_channel in &self.registered_channels {
            let channel_is_subscribed_to_event = registered_channel
                .subscribed_events()
                .contains(&notification_event.event_type);

            if !channel_is_subscribed_to_event {
                continue;
            }

            if let Err(channel_send_error) = registered_channel.send(&notification_event).await {
                error!(
                    channel_name = registered_channel.channel_name(),
                    event_type = %notification_event.event_type,
                    task_id = %notification_event.task_id,
                    error = %channel_send_error,
                    "failed to send notification through channel"
                );
            }
        }
    }

    pub fn channel_count(&self) -> usize {
        self.registered_channels.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifications::types::{NotificationEventType, NotificationEvent};

    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use chrono::Utc;

    struct MockNotificationChannel {
        mock_channel_name: String,
        subscribed_event_types: Vec<NotificationEventType>,
        received_event_summaries: Arc<Mutex<Vec<String>>>,
        should_return_error: bool,
    }

    #[async_trait]
    impl NotificationChannel for MockNotificationChannel {
        async fn send(&self, event: &NotificationEvent) -> Result<(), String> {
            if self.should_return_error {
                return Err("simulated channel failure".to_string());
            }
            self.received_event_summaries
                .lock()
                .unwrap()
                .push(event.summary.clone());
            Ok(())
        }

        fn channel_name(&self) -> &str {
            &self.mock_channel_name
        }

        fn subscribed_events(&self) -> &[NotificationEventType] {
            &self.subscribed_event_types
        }
    }

    fn create_test_event_with_type(event_type: NotificationEventType) -> NotificationEvent {
        NotificationEvent {
            event_type,
            task_name: "test-task".to_string(),
            task_id: "test-id-001".to_string(),
            summary: "test notification summary".to_string(),
            details: HashMap::new(),
            timestamp: Utc::now(),
        }
    }

    #[test]
    fn new_dispatcher_has_zero_channels() {
        let dispatcher = NotificationDispatcher::new();
        assert_eq!(dispatcher.channel_count(), 0);
    }

    #[test]
    fn add_channel_increments_channel_count() {
        let mut dispatcher = NotificationDispatcher::new();

        let received_events = Arc::new(Mutex::new(Vec::new()));
        dispatcher.add_channel(Box::new(MockNotificationChannel {
            mock_channel_name: "test-channel".to_string(),
            subscribed_event_types: vec![NotificationEventType::TaskCompleted],
            received_event_summaries: received_events,
            should_return_error: false,
        }));

        assert_eq!(dispatcher.channel_count(), 1);
    }

    #[tokio::test]
    async fn dispatch_routes_event_to_subscribed_channel() {
        let mut dispatcher = NotificationDispatcher::new();

        let received_event_summaries = Arc::new(Mutex::new(Vec::new()));
        dispatcher.add_channel(Box::new(MockNotificationChannel {
            mock_channel_name: "subscribed-channel".to_string(),
            subscribed_event_types: vec![NotificationEventType::TaskCompleted],
            received_event_summaries: Arc::clone(&received_event_summaries),
            should_return_error: false,
        }));

        let completed_event = create_test_event_with_type(NotificationEventType::TaskCompleted);
        dispatcher.dispatch(completed_event).await;

        let captured_summaries = received_event_summaries.lock().unwrap();
        assert_eq!(captured_summaries.len(), 1);
        assert_eq!(captured_summaries[0], "test notification summary");
    }

    #[tokio::test]
    async fn dispatch_does_not_route_event_to_unsubscribed_channel() {
        let mut dispatcher = NotificationDispatcher::new();

        let received_event_summaries = Arc::new(Mutex::new(Vec::new()));
        dispatcher.add_channel(Box::new(MockNotificationChannel {
            mock_channel_name: "task-failure-only-channel".to_string(),
            subscribed_event_types: vec![NotificationEventType::TaskFailed],
            received_event_summaries: Arc::clone(&received_event_summaries),
            should_return_error: false,
        }));

        let completed_event = create_test_event_with_type(NotificationEventType::TaskCompleted);
        dispatcher.dispatch(completed_event).await;

        let captured_summaries = received_event_summaries.lock().unwrap();
        assert_eq!(captured_summaries.len(), 0);
    }

    #[tokio::test]
    async fn dispatch_routes_to_multiple_subscribed_channels() {
        let mut dispatcher = NotificationDispatcher::new();

        let first_channel_received_summaries = Arc::new(Mutex::new(Vec::new()));
        let second_channel_received_summaries = Arc::new(Mutex::new(Vec::new()));

        dispatcher.add_channel(Box::new(MockNotificationChannel {
            mock_channel_name: "first-channel".to_string(),
            subscribed_event_types: vec![NotificationEventType::TaskFailed],
            received_event_summaries: Arc::clone(&first_channel_received_summaries),
            should_return_error: false,
        }));

        dispatcher.add_channel(Box::new(MockNotificationChannel {
            mock_channel_name: "second-channel".to_string(),
            subscribed_event_types: vec![NotificationEventType::TaskFailed, NotificationEventType::TaskCompleted],
            received_event_summaries: Arc::clone(&second_channel_received_summaries),
            should_return_error: false,
        }));

        let failed_event = create_test_event_with_type(NotificationEventType::TaskFailed);
        dispatcher.dispatch(failed_event).await;

        assert_eq!(first_channel_received_summaries.lock().unwrap().len(), 1);
        assert_eq!(second_channel_received_summaries.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn dispatch_logs_error_but_does_not_panic_on_channel_failure() {
        let mut dispatcher = NotificationDispatcher::new();

        let successful_channel_received_summaries = Arc::new(Mutex::new(Vec::new()));

        dispatcher.add_channel(Box::new(MockNotificationChannel {
            mock_channel_name: "failing-channel".to_string(),
            subscribed_event_types: vec![NotificationEventType::TaskCompleted],
            received_event_summaries: Arc::new(Mutex::new(Vec::new())),
            should_return_error: true,
        }));

        dispatcher.add_channel(Box::new(MockNotificationChannel {
            mock_channel_name: "successful-channel".to_string(),
            subscribed_event_types: vec![NotificationEventType::TaskCompleted],
            received_event_summaries: Arc::clone(&successful_channel_received_summaries),
            should_return_error: false,
        }));

        let completed_event = create_test_event_with_type(NotificationEventType::TaskCompleted);
        dispatcher.dispatch(completed_event).await;

        assert_eq!(successful_channel_received_summaries.lock().unwrap().len(), 1);
    }
}
