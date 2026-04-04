use std::collections::HashMap;
use std::fmt;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;

#[derive(Debug)]
#[allow(dead_code)]
pub enum ChannelError {
    ConnectionFailed(String),
    SendFailed(String),
    AuthenticationFailed(String),
    Shutdown(String),
}

impl fmt::Display for ChannelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChannelError::ConnectionFailed(message) => {
                write!(formatter, "connection failed: {message}")
            }
            ChannelError::SendFailed(message) => write!(formatter, "send failed: {message}"),
            ChannelError::AuthenticationFailed(message) => {
                write!(formatter, "authentication failed: {message}")
            }
            ChannelError::Shutdown(message) => write!(formatter, "shutdown: {message}"),
        }
    }
}

impl std::error::Error for ChannelError {}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct InboundMessage {
    pub channel_type: String,
    pub chat_id: String,
    pub sender_id: String,
    pub text: String,
    pub timestamp: DateTime<Utc>,
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum MessageContent {
    Text(String),
    Html(String),
    Error(String),
}

#[async_trait]
#[allow(dead_code)]
pub trait ChannelAdapter: Send + Sync {
    fn channel_type(&self) -> &str;

    async fn start(
        &self,
        message_tx: tokio::sync::mpsc::Sender<InboundMessage>,
    ) -> Result<(), ChannelError>;

    async fn send_message(
        &self,
        chat_id: &str,
        content: MessageContent,
    ) -> Result<(), ChannelError>;

    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        content: MessageContent,
    ) -> Result<i32, ChannelError>;

    async fn edit_message(
        &self,
        chat_id: &str,
        message_id: i32,
        content: MessageContent,
    ) -> Result<(), ChannelError>;

    async fn send_typing(&self, chat_id: &str) -> Result<(), ChannelError>;

    async fn send_draft(
        &self,
        chat_id: &str,
        draft_id: i32,
        text: &str,
        parse_mode: Option<&str>,
    ) -> Result<(), ChannelError>;

    async fn shutdown(&self) -> Result<(), ChannelError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_error_display_connection_failed() {
        let error = ChannelError::ConnectionFailed("timeout".to_string());
        assert_eq!(format!("{error}"), "connection failed: timeout");
    }

    #[test]
    fn channel_error_display_send_failed() {
        let error = ChannelError::SendFailed("rate limited".to_string());
        assert_eq!(format!("{error}"), "send failed: rate limited");
    }

    #[test]
    fn channel_error_display_authentication_failed() {
        let error = ChannelError::AuthenticationFailed("invalid token".to_string());
        assert_eq!(format!("{error}"), "authentication failed: invalid token");
    }

    #[test]
    fn channel_error_display_shutdown() {
        let error = ChannelError::Shutdown("graceful".to_string());
        assert_eq!(format!("{error}"), "shutdown: graceful");
    }

    #[test]
    fn inbound_message_clone() {
        let message = InboundMessage {
            channel_type: "telegram".to_string(),
            chat_id: "123".to_string(),
            sender_id: "456".to_string(),
            text: "hello".to_string(),
            timestamp: Utc::now(),
            metadata: HashMap::new(),
        };
        let cloned = message.clone();
        assert_eq!(cloned.channel_type, "telegram");
        assert_eq!(cloned.chat_id, "123");
        assert_eq!(cloned.text, "hello");
    }

    #[test]
    fn message_content_variants() {
        let text = MessageContent::Text("hello".to_string());
        let html = MessageContent::Html("<b>bold</b>".to_string());
        let error = MessageContent::Error("failed".to_string());

        match text {
            MessageContent::Text(content) => assert_eq!(content, "hello"),
            _ => panic!("expected Text variant"),
        }

        match html {
            MessageContent::Html(content) => assert_eq!(content, "<b>bold</b>"),
            _ => panic!("expected Html variant"),
        }

        match error {
            MessageContent::Error(content) => assert_eq!(content, "failed"),
            _ => panic!("expected Error variant"),
        }
    }
}
