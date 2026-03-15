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

const DISCORD_POLLING_INTERVAL_SECONDS: u64 = 10;
const DISCORD_API_BASE_URL: &str = "https://discord.com/api/v10";
const DISCORD_MESSAGE_FETCH_LIMIT: u32 = 20;

#[derive(Debug, Deserialize)]
struct DiscordMessage {
    id: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    author: Option<DiscordMessageAuthor>,
    channel_id: String,
}

#[derive(Debug, Deserialize)]
struct DiscordMessageAuthor {
    #[serde(default)]
    id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    bot: Option<bool>,
}

pub struct DiscordBotListener {
    trigger_config: SlashCommandTriggerConfig,
    trigger_engine: Arc<TriggerEngine>,
}

impl DiscordBotListener {
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
        let mut last_seen_message_id = String::new();

        info!(
            listener_name = %self.trigger_config.name,
            channel = %self.trigger_config.channel,
            mention_keyword = %self.trigger_config.mention,
            "discord bot listener started"
        );

        loop {
            tokio::select! {
                _ = shutdown_receiver.changed() => {
                    info!(
                        listener_name = %self.trigger_config.name,
                        "discord bot listener shutting down"
                    );
                    break;
                }
                _ = tokio::time::sleep(Duration::from_secs(DISCORD_POLLING_INTERVAL_SECONDS)) => {
                    self.poll_for_mentions(&http_client, &mut last_seen_message_id).await;
                }
            }
        }
    }

    async fn poll_for_mentions(
        &self,
        http_client: &reqwest::Client,
        last_seen_message_id: &mut String,
    ) {
        let mut request_url_with_parameters = format!(
            "{}/channels/{}/messages?limit={}",
            DISCORD_API_BASE_URL,
            self.trigger_config.channel,
            DISCORD_MESSAGE_FETCH_LIMIT,
        );

        if !last_seen_message_id.is_empty() {
            request_url_with_parameters
                .push_str(&format!("&after={}", last_seen_message_id));
        }

        let api_response_result = http_client
            .get(&request_url_with_parameters)
            .header("Authorization", format!("Bot {}", self.trigger_config.token))
            .send()
            .await;

        let api_response = match api_response_result {
            Ok(response) => response,
            Err(request_error) => {
                warn!(
                    listener_name = %self.trigger_config.name,
                    error = %request_error,
                    "failed to poll discord channel messages"
                );
                return;
            }
        };

        if !api_response.status().is_success() {
            warn!(
                listener_name = %self.trigger_config.name,
                status = %api_response.status(),
                "discord API returned non-success status for channel messages"
            );
            return;
        }

        let parsed_messages = match api_response.json::<Vec<DiscordMessage>>().await {
            Ok(messages) => messages,
            Err(parse_error) => {
                warn!(
                    listener_name = %self.trigger_config.name,
                    error = %parse_error,
                    "failed to parse discord channel messages response"
                );
                return;
            }
        };

        for message in &parsed_messages {
            let is_bot_message = message
                .author
                .as_ref()
                .and_then(|author| author.bot)
                .unwrap_or(false);

            if is_bot_message {
                continue;
            }

            if discord_message_contains_mention(&message.content, &self.trigger_config.mention) {
                self.create_trigger_event_from_discord_message(message).await;
            }
        }

        if let Some(newest_message) = find_newest_discord_message(&parsed_messages)
            && newest_message.id > *last_seen_message_id
        {
            *last_seen_message_id = newest_message.id.clone();
        }
    }

    async fn create_trigger_event_from_discord_message(&self, message: &DiscordMessage) {
        let author_username = message
            .author
            .as_ref()
            .map(|author| author.username.as_str())
            .unwrap_or("unknown");

        let author_id = message
            .author
            .as_ref()
            .map(|author| author.id.as_str())
            .unwrap_or("unknown");

        let message_payload = json!({
            "message": {
                "text": message.content,
                "user": author_username,
                "user_id": author_id,
                "channel": message.channel_id,
                "message_id": message.id,
            },
            "provider": "discord",
            "channel_id": self.trigger_config.channel,
        });

        let rendered_task_description = render_template(
            &self.trigger_config.task_template,
            &message_payload,
        );

        let trigger_event_source = format!("discord:{}", self.trigger_config.channel);

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
                message_id = %message.id,
                "discord bot listener created task from mention"
            );
        }
    }
}

fn find_newest_discord_message(messages: &[DiscordMessage]) -> Option<&DiscordMessage> {
    messages.iter().max_by(|a, b| a.id.cmp(&b.id))
}

pub fn discord_message_contains_mention(message_content: &str, mention_keyword: &str) -> bool {
    let lowercase_message_content = message_content.to_lowercase();
    let lowercase_mention_keyword = mention_keyword.to_lowercase();
    lowercase_message_content.contains(&lowercase_mention_keyword)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discord_mention_detection_exact_match() {
        assert!(discord_message_contains_mention(
            "hey @kraken fix this",
            "@kraken"
        ));
    }

    #[test]
    fn test_discord_mention_detection_case_insensitive() {
        assert!(discord_message_contains_mention(
            "Hey @Kraken please help",
            "@kraken"
        ));
    }

    #[test]
    fn test_discord_mention_detection_no_match() {
        assert!(!discord_message_contains_mention(
            "this is a normal message",
            "@kraken"
        ));
    }

    #[test]
    fn test_discord_mention_detection_at_start_of_message() {
        assert!(discord_message_contains_mention(
            "@kraken do something",
            "@kraken"
        ));
    }

    #[test]
    fn test_discord_mention_detection_at_end_of_message() {
        assert!(discord_message_contains_mention(
            "please help @kraken",
            "@kraken"
        ));
    }

    #[test]
    fn test_discord_mention_detection_empty_message() {
        assert!(!discord_message_contains_mention("", "@kraken"));
    }

    #[test]
    fn test_discord_mention_detection_custom_keyword() {
        assert!(discord_message_contains_mention(
            "hey @mybot do this",
            "@mybot"
        ));
    }

    #[test]
    fn test_discord_bot_messages_are_skipped() {
        let bot_message = DiscordMessage {
            id: "111".to_string(),
            content: "@kraken hello".to_string(),
            author: Some(DiscordMessageAuthor {
                id: "bot-id".to_string(),
                username: "SomeBot".to_string(),
                bot: Some(true),
            }),
            channel_id: "C12345".to_string(),
        };

        let is_bot = bot_message
            .author
            .as_ref()
            .and_then(|author| author.bot)
            .unwrap_or(false);

        assert!(is_bot);
    }

    #[test]
    fn test_discord_human_messages_are_not_skipped() {
        let human_message = DiscordMessage {
            id: "222".to_string(),
            content: "@kraken fix this".to_string(),
            author: Some(DiscordMessageAuthor {
                id: "user-id".to_string(),
                username: "HumanUser".to_string(),
                bot: None,
            }),
            channel_id: "C12345".to_string(),
        };

        let is_bot = human_message
            .author
            .as_ref()
            .and_then(|author| author.bot)
            .unwrap_or(false);

        assert!(!is_bot);
    }

    #[test]
    fn test_discord_trigger_event_payload_structure() {
        let message = DiscordMessage {
            id: "msg-123".to_string(),
            content: "hey @kraken fix the build".to_string(),
            author: Some(DiscordMessageAuthor {
                id: "user-456".to_string(),
                username: "dev_user".to_string(),
                bot: None,
            }),
            channel_id: "C67890".to_string(),
        };

        let trigger_config = SlashCommandTriggerConfig {
            name: "test-discord".to_string(),
            provider: "discord".to_string(),
            token: "bot-test-token".to_string(),
            app_token: None,
            channel: "C67890".to_string(),
            task_template: "{{event.message.text}}".to_string(),
            mention: "@kraken".to_string(),
        };

        let author_username = message
            .author
            .as_ref()
            .map(|author| author.username.as_str())
            .unwrap_or("unknown");

        let author_id = message
            .author
            .as_ref()
            .map(|author| author.id.as_str())
            .unwrap_or("unknown");

        let message_payload = json!({
            "message": {
                "text": message.content,
                "user": author_username,
                "user_id": author_id,
                "channel": message.channel_id,
                "message_id": message.id,
            },
            "provider": "discord",
            "channel_id": trigger_config.channel,
        });

        let rendered_task_description = render_template(
            &trigger_config.task_template,
            &message_payload,
        );

        assert_eq!(rendered_task_description, "hey @kraken fix the build");
    }

    #[test]
    fn test_discord_trigger_event_payload_with_custom_template() {
        let trigger_config = SlashCommandTriggerConfig {
            name: "test-discord".to_string(),
            provider: "discord".to_string(),
            token: "bot-test-token".to_string(),
            app_token: None,
            channel: "C67890".to_string(),
            task_template: "Discord request from {{event.message.user}}: {{event.message.text}}".to_string(),
            mention: "@kraken".to_string(),
        };

        let message_payload = json!({
            "message": {
                "text": "fix the tests",
                "user": "dev_user",
                "user_id": "user-456",
                "channel": "C67890",
                "message_id": "msg-123",
            },
            "provider": "discord",
            "channel_id": "C67890",
        });

        let rendered_task_description = render_template(
            &trigger_config.task_template,
            &message_payload,
        );

        assert_eq!(
            rendered_task_description,
            "Discord request from dev_user: fix the tests"
        );
    }

    #[test]
    fn test_discord_message_deserialization() {
        let message_json = r#"{
            "id": "123456789",
            "content": "hello @kraken fix this",
            "author": {
                "id": "user-001",
                "username": "testuser",
                "bot": false
            },
            "channel_id": "channel-001"
        }"#;

        let parsed_message: DiscordMessage =
            serde_json::from_str(message_json).expect("should deserialize");

        assert_eq!(parsed_message.id, "123456789");
        assert_eq!(parsed_message.content, "hello @kraken fix this");
        assert_eq!(
            parsed_message.author.as_ref().unwrap().username,
            "testuser"
        );
        assert_eq!(
            parsed_message.author.as_ref().unwrap().bot,
            Some(false)
        );
        assert_eq!(parsed_message.channel_id, "channel-001");
    }

    #[test]
    fn test_discord_message_deserialization_minimal() {
        let message_json = r#"{
            "id": "123456789",
            "channel_id": "channel-001"
        }"#;

        let parsed_message: DiscordMessage =
            serde_json::from_str(message_json).expect("should deserialize");

        assert_eq!(parsed_message.id, "123456789");
        assert_eq!(parsed_message.content, "");
        assert!(parsed_message.author.is_none());
    }

    #[test]
    fn test_find_newest_discord_message_from_list() {
        let messages = vec![
            DiscordMessage {
                id: "100".to_string(),
                content: "first".to_string(),
                author: None,
                channel_id: "C1".to_string(),
            },
            DiscordMessage {
                id: "300".to_string(),
                content: "third".to_string(),
                author: None,
                channel_id: "C1".to_string(),
            },
            DiscordMessage {
                id: "200".to_string(),
                content: "second".to_string(),
                author: None,
                channel_id: "C1".to_string(),
            },
        ];

        let newest_message = find_newest_discord_message(&messages).unwrap();
        assert_eq!(newest_message.id, "300");
    }

    #[test]
    fn test_find_newest_discord_message_empty_list() {
        let messages: Vec<DiscordMessage> = vec![];
        let newest_message = find_newest_discord_message(&messages);
        assert!(newest_message.is_none());
    }
}
