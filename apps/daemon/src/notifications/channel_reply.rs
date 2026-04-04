use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::channels::router::ChannelRouterHandle;
use crate::channels::telegram::markdown_to_telegram_html;
use crate::channels::types::MessageContent;

use super::types::{NotificationChannel, NotificationEvent, NotificationEventType};

const MAX_REPLY_LENGTH: usize = 3500;

pub struct ChannelReplyNotificationChannel {
    channel_router: Arc<RwLock<Option<Arc<ChannelRouterHandle>>>>,
    subscribed_event_types: Vec<NotificationEventType>,
}

impl ChannelReplyNotificationChannel {
    pub fn new(channel_router: Arc<RwLock<Option<Arc<ChannelRouterHandle>>>>) -> Self {
        Self {
            channel_router,
            subscribed_event_types: vec![
                NotificationEventType::TaskCompleted,
                NotificationEventType::TaskFailed,
            ],
        }
    }

    fn format_reply(event: &NotificationEvent) -> String {
        match event.event_type {
            NotificationEventType::TaskCompleted => {
                if let Some(output) = event.details.get("reply_output") {
                    if output.len() > MAX_REPLY_LENGTH {
                        format!("{}...", &output[..MAX_REPLY_LENGTH])
                    } else {
                        output.clone()
                    }
                } else {
                    event.summary.clone()
                }
            }
            NotificationEventType::TaskFailed => {
                let error = event
                    .details
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| "unknown error".to_string());
                format!("Task '{}' failed: {}", event.task_name, error)
            }
            _ => event.summary.clone(),
        }
    }

    fn to_message_content(channel_type: &str, text: String) -> MessageContent {
        match channel_type {
            "telegram" => MessageContent::Html(markdown_to_telegram_html(&text)),
            _ => MessageContent::Text(text),
        }
    }
}

#[async_trait]
impl NotificationChannel for ChannelReplyNotificationChannel {
    async fn send(&self, event: &NotificationEvent) -> Result<(), String> {
        let channel_type = match event.details.get("reply_channel_type") {
            Some(ct) => ct.clone(),
            None => return Ok(()),
        };
        let chat_id = match event.details.get("reply_chat_id") {
            Some(id) => id.clone(),
            None => return Ok(()),
        };

        let router_guard = self.channel_router.read().await;
        let router_handle = match router_guard.as_ref() {
            Some(handle) => handle,
            None => {
                warn!(
                    channel_type = %channel_type,
                    chat_id = %chat_id,
                    "channel router not available for reply"
                );
                return Err("channel router not available".to_string());
            }
        };

        let adapter = match router_handle.get_adapter(&channel_type) {
            Some(adapter) => adapter,
            None => {
                warn!(
                    channel_type = %channel_type,
                    "no adapter found for channel reply"
                );
                return Err(format!("no adapter for channel type: {channel_type}"));
            }
        };

        let reply_text = Self::format_reply(event);
        let content = Self::to_message_content(&channel_type, reply_text);

        info!(
            channel_type = %channel_type,
            chat_id = %chat_id,
            task_id = %event.task_id,
            "sending task result to channel"
        );

        adapter
            .send_message(&chat_id, content)
            .await
            .map_err(|error| format!("failed to send channel reply: {error}"))
    }

    fn channel_name(&self) -> &str {
        "channel-reply"
    }

    fn subscribed_events(&self) -> &[NotificationEventType] {
        &self.subscribed_event_types
    }
}
