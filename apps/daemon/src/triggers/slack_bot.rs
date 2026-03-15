use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::watch;
use tracing::{info, warn};
use uuid::Uuid;

use super::engine::TriggerEngine;
use super::types::{TriggerEvent, TriggerType, SlashCommandTriggerConfig, render_template};

const SLACK_POLLING_INTERVAL_SECONDS: u64 = 10;
const SLACK_CONVERSATIONS_HISTORY_URL: &str = "https://slack.com/api/conversations.history";
const SLACK_MESSAGE_FETCH_LIMIT: u32 = 20;

#[derive(Debug, Deserialize)]
struct SlackConversationsHistoryResponse {
    ok: bool,
    #[serde(default)]
    messages: Vec<SlackMessage>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackMessage {
    #[serde(default)]
    text: String,
    #[serde(default)]
    ts: String,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    channel: Option<String>,
}

pub struct SlackBotListener {
    trigger_config: SlashCommandTriggerConfig,
    trigger_engine: Arc<TriggerEngine>,
}

impl SlackBotListener {
    pub fn new(
        trigger_config: SlashCommandTriggerConfig,
        trigger_engine: Arc<TriggerEngine>,
    ) -> Self {
        Self {
            trigger_config,
            trigger_engine,
        }
    }

    pub async fn run(self, mut shutdown_receiver: watch::Receiver<bool>) {
        let http_client = reqwest::Client::new();
        let mut last_seen_timestamp = String::new();

        info!(
            listener_name = %self.trigger_config.name,
            channel = %self.trigger_config.channel,
            mention_keyword = %self.trigger_config.mention,
            "slack bot listener started"
        );

        loop {
            tokio::select! {
                _ = shutdown_receiver.changed() => {
                    info!(
                        listener_name = %self.trigger_config.name,
                        "slack bot listener shutting down"
                    );
                    break;
                }
                _ = tokio::time::sleep(Duration::from_secs(SLACK_POLLING_INTERVAL_SECONDS)) => {
                    self.poll_for_mentions(&http_client, &mut last_seen_timestamp).await;
                }
            }
        }
    }

    async fn poll_for_mentions(
        &self,
        http_client: &reqwest::Client,
        last_seen_timestamp: &mut String,
    ) {
        let mut request_url_with_parameters = format!(
            "{}?channel={}&limit={}",
            SLACK_CONVERSATIONS_HISTORY_URL,
            self.trigger_config.channel,
            SLACK_MESSAGE_FETCH_LIMIT,
        );

        if !last_seen_timestamp.is_empty() {
            request_url_with_parameters
                .push_str(&format!("&oldest={}", last_seen_timestamp));
        }

        let api_response_result = http_client
            .get(&request_url_with_parameters)
            .header("Authorization", format!("Bearer {}", self.trigger_config.token))
            .send()
            .await;

        let api_response = match api_response_result {
            Ok(response) => response,
            Err(request_error) => {
                warn!(
                    listener_name = %self.trigger_config.name,
                    error = %request_error,
                    "failed to poll slack conversations.history"
                );
                return;
            }
        };

        let parsed_response = match api_response.json::<SlackConversationsHistoryResponse>().await {
            Ok(parsed) => parsed,
            Err(parse_error) => {
                warn!(
                    listener_name = %self.trigger_config.name,
                    error = %parse_error,
                    "failed to parse slack conversations.history response"
                );
                return;
            }
        };

        if !parsed_response.ok {
            warn!(
                listener_name = %self.trigger_config.name,
                error = ?parsed_response.error,
                "slack API returned error for conversations.history"
            );
            return;
        }

        for message in &parsed_response.messages {
            if message.ts <= *last_seen_timestamp {
                continue;
            }

            if message_text_contains_mention(&message.text, &self.trigger_config.mention) {
                self.create_trigger_event_from_slack_message(message).await;
            }
        }

        if let Some(newest_message) = parsed_response
            .messages
            .iter()
            .max_by(|a, b| a.ts.cmp(&b.ts))
            && newest_message.ts > *last_seen_timestamp
        {
            *last_seen_timestamp = newest_message.ts.clone();
        }
    }

    async fn create_trigger_event_from_slack_message(&self, message: &SlackMessage) {
        let message_payload = json!({
            "message": {
                "text": message.text,
                "user": message.user,
                "channel": message.channel.as_deref().unwrap_or(&self.trigger_config.channel),
                "timestamp": message.ts,
            },
            "provider": "slack",
            "channel_id": self.trigger_config.channel,
        });

        let rendered_task_description = render_template(
            &self.trigger_config.task_template,
            &message_payload,
        );

        let trigger_event_source = format!("slack:{}", self.trigger_config.channel);

        let trigger_event = TriggerEvent {
            id: Uuid::new_v4().to_string(),
            trigger_type: TriggerType::SlashCommand,
            source: trigger_event_source,
            payload: json!({ "command": rendered_task_description }),
            fired_at: Utc::now(),
        };

        let maybe_created_task_id = self
            .trigger_engine
            .handle_trigger_event(trigger_event)
            .await;

        if let Some(created_task_id) = maybe_created_task_id {
            info!(
                listener_name = %self.trigger_config.name,
                task_id = %created_task_id,
                message_timestamp = %message.ts,
                "slack bot listener created task from mention"
            );
        }
    }
}

pub fn message_text_contains_mention(message_text: &str, mention_keyword: &str) -> bool {
    let lowercase_message_text = message_text.to_lowercase();
    let lowercase_mention_keyword = mention_keyword.to_lowercase();
    lowercase_message_text.contains(&lowercase_mention_keyword)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mention_detection_exact_match() {
        assert!(message_text_contains_mention("hey @kraken fix this", "@kraken"));
    }

    #[test]
    fn test_mention_detection_case_insensitive() {
        assert!(message_text_contains_mention("Hey @Kraken please help", "@kraken"));
    }

    #[test]
    fn test_mention_detection_no_match() {
        assert!(!message_text_contains_mention("this is a normal message", "@kraken"));
    }

    #[test]
    fn test_mention_detection_at_start_of_message() {
        assert!(message_text_contains_mention("@kraken do something", "@kraken"));
    }

    #[test]
    fn test_mention_detection_at_end_of_message() {
        assert!(message_text_contains_mention("please help @kraken", "@kraken"));
    }

    #[test]
    fn test_mention_detection_empty_message() {
        assert!(!message_text_contains_mention("", "@kraken"));
    }

    #[test]
    fn test_mention_detection_custom_keyword() {
        assert!(message_text_contains_mention("hey @mybot do this", "@mybot"));
    }

    #[test]
    fn test_mention_detection_partial_keyword_no_false_positive() {
        assert!(!message_text_contains_mention("krakens are cool", "@kraken"));
    }

    #[test]
    fn test_slack_trigger_event_payload_structure() {
        let message = SlackMessage {
            text: "hey @kraken fix the build".to_string(),
            ts: "1710400000.000001".to_string(),
            user: Some("U12345".to_string()),
            channel: Some("C67890".to_string()),
        };

        let trigger_config = SlashCommandTriggerConfig {
            name: "test-slack".to_string(),
            provider: "slack".to_string(),
            token: "xoxb-test-token".to_string(),
            app_token: None,
            channel: "C67890".to_string(),
            task_template: "{{event.message.text}}".to_string(),
            mention: "@kraken".to_string(),
        };

        let message_payload = json!({
            "message": {
                "text": message.text,
                "user": message.user,
                "channel": message.channel.as_deref().unwrap_or(&trigger_config.channel),
                "timestamp": message.ts,
            },
            "provider": "slack",
            "channel_id": trigger_config.channel,
        });

        let rendered_task_description = render_template(
            &trigger_config.task_template,
            &message_payload,
        );

        assert_eq!(rendered_task_description, "hey @kraken fix the build");
    }

    #[test]
    fn test_slack_trigger_event_payload_with_custom_template() {
        let trigger_config = SlashCommandTriggerConfig {
            name: "test-slack".to_string(),
            provider: "slack".to_string(),
            token: "xoxb-test-token".to_string(),
            app_token: None,
            channel: "C67890".to_string(),
            task_template: "Slack request from {{event.message.user}}: {{event.message.text}}".to_string(),
            mention: "@kraken".to_string(),
        };

        let message_payload = json!({
            "message": {
                "text": "fix the tests",
                "user": "U12345",
                "channel": "C67890",
                "timestamp": "1710400000.000001",
            },
            "provider": "slack",
            "channel_id": "C67890",
        });

        let rendered_task_description = render_template(
            &trigger_config.task_template,
            &message_payload,
        );

        assert_eq!(
            rendered_task_description,
            "Slack request from U12345: fix the tests"
        );
    }

    #[test]
    fn test_slack_conversations_history_response_deserialization() {
        let response_json = r#"{
            "ok": true,
            "messages": [
                {
                    "text": "hello @kraken",
                    "ts": "1710400000.000001",
                    "user": "U12345"
                },
                {
                    "text": "normal message",
                    "ts": "1710400000.000002",
                    "user": "U67890"
                }
            ]
        }"#;

        let parsed_response: SlackConversationsHistoryResponse =
            serde_json::from_str(response_json).expect("should deserialize");

        assert!(parsed_response.ok);
        assert_eq!(parsed_response.messages.len(), 2);
        assert_eq!(parsed_response.messages[0].text, "hello @kraken");
        assert_eq!(parsed_response.messages[0].ts, "1710400000.000001");
        assert_eq!(
            parsed_response.messages[0].user.as_deref(),
            Some("U12345")
        );
    }

    #[test]
    fn test_slack_conversations_history_error_response_deserialization() {
        let error_response_json = r#"{
            "ok": false,
            "error": "channel_not_found"
        }"#;

        let parsed_response: SlackConversationsHistoryResponse =
            serde_json::from_str(error_response_json).expect("should deserialize");

        assert!(!parsed_response.ok);
        assert_eq!(parsed_response.error.as_deref(), Some("channel_not_found"));
        assert!(parsed_response.messages.is_empty());
    }

    #[test]
    fn test_filtering_messages_by_timestamp() {
        let last_seen_timestamp = "1710400000.000002".to_string();

        let older_message = SlackMessage {
            text: "@kraken old".to_string(),
            ts: "1710400000.000001".to_string(),
            user: None,
            channel: None,
        };

        let equal_timestamp_message = SlackMessage {
            text: "@kraken same".to_string(),
            ts: "1710400000.000002".to_string(),
            user: None,
            channel: None,
        };

        let newer_message = SlackMessage {
            text: "@kraken new".to_string(),
            ts: "1710400000.000003".to_string(),
            user: None,
            channel: None,
        };

        assert!(older_message.ts <= last_seen_timestamp);
        assert!(equal_timestamp_message.ts <= last_seen_timestamp);
        assert!(!(newer_message.ts <= last_seen_timestamp));
    }
}
