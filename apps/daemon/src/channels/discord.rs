use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use serenity::Client;
use serenity::all::{
    ChannelId, Command, CommandOptionType, Context, CreateCommand, CreateCommandOption,
    EditMessage, EventHandler, GatewayIntents, Message, MessageId, Ready,
};
use tokio::sync::{mpsc, watch};
use tracing::{error, info, warn};

use crate::daemon::config::DmPolicy;
use crate::db::channel_users::ChannelUserStore;

use super::types::{ChannelAdapter, ChannelError, InboundMessage, MessageContent};

const DISCORD_MAX_MESSAGE_LENGTH: usize = 2000;

pub struct DiscordAdapter {
    token: String,
    dm_policy: DmPolicy,
    allow_from: Vec<u64>,
    allowed_channels: Vec<u64>,
    user_store: Option<Arc<ChannelUserStore>>,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
    /// Shared HTTP client for sending messages outside the event handler.
    http: Arc<tokio::sync::RwLock<Option<Arc<serenity::http::Http>>>>,
    /// Map of draft_id → (ChannelId, MessageId) for draft streaming via message edits.
    draft_messages: Arc<DashMap<i32, (u64, u64)>>,
}

impl DiscordAdapter {
    pub fn new(
        token: String,
        dm_policy: DmPolicy,
        allow_from: Vec<u64>,
        allowed_channels: Vec<u64>,
    ) -> Self {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        Self {
            token,
            dm_policy,
            allow_from,
            allowed_channels,
            user_store: None,
            shutdown_tx,
            shutdown_rx,
            http: Arc::new(tokio::sync::RwLock::new(None)),
            draft_messages: Arc::new(DashMap::new()),
        }
    }

    pub fn with_user_store(mut self, user_store: Arc<ChannelUserStore>) -> Self {
        self.user_store = Some(user_store);
        self
    }
}

fn content_to_markdown(content: MessageContent) -> String {
    match content {
        MessageContent::Text(text) => text,
        MessageContent::Html(html) => strip_html_tags(&html),
        MessageContent::Error(err) => format!("⚠️ {err}"),
    }
}

fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag_name = String::new();
    let mut collecting_tag = false;

    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            collecting_tag = true;
            tag_name.clear();
            continue;
        }
        if in_tag {
            if collecting_tag && (ch == ' ' || ch == '>' || ch == '/') {
                collecting_tag = false;
            }
            if collecting_tag {
                tag_name.push(ch);
            }
            if ch == '>' {
                in_tag = false;
                // Map HTML tags to markdown
                match tag_name.as_str() {
                    "b" | "strong" => result.push_str("**"),
                    "/b" | "/strong" => result.push_str("**"),
                    "i" | "em" => result.push('*'),
                    "/i" | "/em" => result.push('*'),
                    "code" => result.push('`'),
                    "/code" => result.push('`'),
                    "pre" => result.push_str("```\n"),
                    "/pre" => result.push_str("\n```"),
                    _ => {}
                }
            }
            continue;
        }
        // Unescape HTML entities
        result.push(ch);
    }

    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn split_message(text: &str, max_length: usize) -> Vec<String> {
    if text.len() <= max_length {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_length {
            chunks.push(remaining.to_string());
            break;
        }

        let split_point = remaining[..max_length].rfind('\n').unwrap_or(max_length);
        let (chunk, rest) = remaining.split_at(split_point);
        chunks.push(chunk.to_string());
        remaining = rest.trim_start_matches('\n');
    }

    chunks
}

fn parse_channel_id(chat_id: &str) -> Result<ChannelId, ChannelError> {
    let parsed: u64 = chat_id
        .parse()
        .map_err(|_| ChannelError::SendFailed(format!("invalid channel_id: {chat_id}")))?;
    Ok(ChannelId::new(parsed))
}

// ── Event Handler ─────────────────────────────────────────────────────

struct DiscordHandler {
    message_tx: mpsc::Sender<InboundMessage>,
    dm_policy: DmPolicy,
    allow_from: Vec<u64>,
    allowed_channels: Vec<u64>,
    user_store: Option<Arc<ChannelUserStore>>,
    http_store: Arc<tokio::sync::RwLock<Option<Arc<serenity::http::Http>>>>,
}

#[async_trait]
impl EventHandler for DiscordHandler {
    async fn ready(&self, ctx: Context, ready: Ready) {
        info!(bot_name = %ready.user.name, "discord bot connected");

        // Store HTTP client for use in send_message etc.
        {
            let mut http_guard = self.http_store.write().await;
            *http_guard = Some(ctx.http.clone());
        }

        // Register slash commands
        let commands = vec![
            CreateCommand::new("task")
                .description("Run a background task")
                .add_option(
                    CreateCommandOption::new(CommandOptionType::String, "prompt", "What to do")
                        .required(true),
                ),
            CreateCommand::new("new").description("Start a new conversation"),
            CreateCommand::new("model")
                .description("Show or change model")
                .add_option(
                    CreateCommandOption::new(CommandOptionType::String, "name", "Model name")
                        .required(false),
                ),
            CreateCommand::new("cost").description("Show usage and costs"),
            CreateCommand::new("status").description("Show daemon status"),
            CreateCommand::new("repos").description("List configured repos"),
            CreateCommand::new("users").description("List authorized users"),
            CreateCommand::new("help").description("List all commands"),
        ];

        for cmd in commands {
            if let Err(err) = Command::create_global_command(&ctx.http, cmd).await {
                warn!(error = %err, "failed to register discord slash command");
            }
        }

        info!("discord slash commands registered");
    }

    async fn message(&self, _ctx: Context, msg: Message) {
        // Ignore bots
        if msg.author.bot {
            return;
        }

        let sender_id = msg.author.id.get();
        let channel_id = msg.channel_id.get();

        // Channel filter: if allowed_channels is set, only respond in those
        if !self.allowed_channels.is_empty() && !self.allowed_channels.contains(&channel_id) {
            return;
        }

        // DM Policy enforcement
        match self.dm_policy {
            DmPolicy::Disabled => return,
            DmPolicy::Allowlist => {
                if !self.allow_from.contains(&sender_id) {
                    return;
                }
            }
            DmPolicy::Pairing => {
                if let Some(ref store) = self.user_store {
                    let platform_id = sender_id.to_string();
                    match store.is_authorized("discord", &platform_id).await {
                        Ok(true) => { /* authorized */ }
                        Ok(false) => {
                            // Send pairing code
                            let display_name = msg.author.name.clone();
                            let pending = store
                                .get_pending_requests("discord")
                                .await
                                .map(|r| r.len())
                                .unwrap_or(0);

                            if pending >= 3 {
                                warn!(sender_id, "too many pending discord pairing requests");
                                return;
                            }

                            match store
                                .create_pairing_request(
                                    "discord",
                                    &platform_id,
                                    Some(&display_name),
                                )
                                .await
                            {
                                Ok(code) => {
                                    let text = format!(
                                        "🔐 **Pairing required**\n\n\
                                         Your code: `{code}`\n\n\
                                         Share this code with the Kraken owner to get access.\n\
                                         This code expires in 1 hour."
                                    );
                                    let _ = msg.channel_id.say(&_ctx.http, text).await;
                                }
                                Err(err) => {
                                    error!(error = %err, "failed to create discord pairing request");
                                }
                            }
                            return;
                        }
                        Err(err) => {
                            error!(error = %err, "failed to check discord authorization");
                            return;
                        }
                    }
                } else if !self.allow_from.is_empty() && !self.allow_from.contains(&sender_id) {
                    return;
                }
            }
        }

        let text = msg.content.clone();
        if text.is_empty() {
            return;
        }

        let inbound = InboundMessage {
            channel_type: "discord".to_string(),
            chat_id: channel_id.to_string(),
            sender_id: sender_id.to_string(),
            text,
            timestamp: chrono::Utc::now(),
            metadata: HashMap::new(),
        };

        if let Err(err) = self.message_tx.send(inbound).await {
            error!(error = %err, "failed to forward discord message");
        }
    }
}

// ── ChannelAdapter Implementation ─────────────────────────────────────

#[async_trait]
impl ChannelAdapter for DiscordAdapter {
    fn channel_type(&self) -> &str {
        "discord"
    }

    async fn start(&self, message_tx: mpsc::Sender<InboundMessage>) -> Result<(), ChannelError> {
        let token = self.token.clone();
        let dm_policy = self.dm_policy;
        let allow_from = self.allow_from.clone();
        let allowed_channels = self.allowed_channels.clone();
        let user_store = self.user_store.clone();
        let http_store = Arc::clone(&self.http);
        let mut shutdown_rx = self.shutdown_rx.clone();

        info!(dm_policy = ?dm_policy, "starting discord gateway");

        let intents = GatewayIntents::GUILD_MESSAGES
            | GatewayIntents::MESSAGE_CONTENT
            | GatewayIntents::DIRECT_MESSAGES;

        let handler = DiscordHandler {
            message_tx,
            dm_policy,
            allow_from,
            allowed_channels,
            user_store,
            http_store,
        };

        tokio::spawn(async move {
            let mut client = match Client::builder(&token, intents)
                .event_handler(handler)
                .await
            {
                Ok(client) => client,
                Err(err) => {
                    error!(error = %err, "failed to create discord client");
                    return;
                }
            };

            let shard_manager = client.shard_manager.clone();

            tokio::select! {
                result = client.start() => {
                    if let Err(err) = result {
                        error!(error = %err, "discord client error");
                    }
                    info!("discord client stopped");
                }
                _ = shutdown_rx.changed() => {
                    info!("discord adapter received shutdown signal");
                    shard_manager.shutdown_all().await;
                }
            }
        });

        Ok(())
    }

    async fn send_message(
        &self,
        chat_id: &str,
        content: MessageContent,
    ) -> Result<(), ChannelError> {
        let http_guard = self.http.read().await;
        let http = http_guard
            .as_ref()
            .ok_or_else(|| ChannelError::SendFailed("discord not connected yet".to_string()))?;

        let channel_id = parse_channel_id(chat_id)?;
        let text = content_to_markdown(content);
        let chunks = split_message(&text, DISCORD_MAX_MESSAGE_LENGTH);

        for chunk in chunks {
            channel_id
                .say(http, &chunk)
                .await
                .map_err(|e| ChannelError::SendFailed(format!("discord send error: {e}")))?;
        }

        Ok(())
    }

    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        content: MessageContent,
    ) -> Result<i32, ChannelError> {
        let http_guard = self.http.read().await;
        let http = http_guard
            .as_ref()
            .ok_or_else(|| ChannelError::SendFailed("discord not connected yet".to_string()))?;

        let channel_id = parse_channel_id(chat_id)?;
        let text = content_to_markdown(content);

        let sent = channel_id
            .say(http, &text)
            .await
            .map_err(|e| ChannelError::SendFailed(format!("discord send error: {e}")))?;

        Ok(sent.id.get() as i32)
    }

    async fn edit_message(
        &self,
        chat_id: &str,
        message_id: i32,
        content: MessageContent,
    ) -> Result<(), ChannelError> {
        let http_guard = self.http.read().await;
        let http = http_guard
            .as_ref()
            .ok_or_else(|| ChannelError::SendFailed("discord not connected yet".to_string()))?;

        let channel_id = parse_channel_id(chat_id)?;
        let text = content_to_markdown(content);

        channel_id
            .edit_message(
                http,
                MessageId::new(message_id as u64),
                EditMessage::default().content(&text),
            )
            .await
            .map_err(|e| ChannelError::SendFailed(format!("discord edit error: {e}")))?;

        Ok(())
    }

    async fn send_typing(&self, chat_id: &str) -> Result<(), ChannelError> {
        let http_guard = self.http.read().await;
        let http = http_guard
            .as_ref()
            .ok_or_else(|| ChannelError::SendFailed("discord not connected yet".to_string()))?;

        let channel_id = parse_channel_id(chat_id)?;

        channel_id
            .broadcast_typing(http)
            .await
            .map_err(|e| ChannelError::SendFailed(format!("discord typing error: {e}")))?;

        Ok(())
    }

    async fn send_draft(
        &self,
        chat_id: &str,
        draft_id: i32,
        text: &str,
        _parse_mode: Option<&str>,
    ) -> Result<(), ChannelError> {
        let http_guard = self.http.read().await;
        let http = http_guard
            .as_ref()
            .ok_or_else(|| ChannelError::SendFailed("discord not connected yet".to_string()))?;

        let channel_id = parse_channel_id(chat_id)?;
        let truncated = if text.len() > DISCORD_MAX_MESSAGE_LENGTH {
            &text[..DISCORD_MAX_MESSAGE_LENGTH]
        } else {
            text
        };

        if let Some(entry) = self.draft_messages.get(&draft_id) {
            let (_, msg_id) = *entry;
            // Edit existing draft message
            channel_id
                .edit_message(
                    http,
                    MessageId::new(msg_id),
                    EditMessage::default().content(truncated),
                )
                .await
                .map_err(|e| ChannelError::SendFailed(format!("discord draft edit error: {e}")))?;
        } else {
            // Send new message and store the ID
            let sent = channel_id
                .say(http, truncated)
                .await
                .map_err(|e| ChannelError::SendFailed(format!("discord draft send error: {e}")))?;

            self.draft_messages
                .insert(draft_id, (channel_id.get(), sent.id.get()));
        }

        Ok(())
    }

    async fn shutdown(&self) -> Result<(), ChannelError> {
        info!("shutting down discord adapter");
        self.shutdown_tx
            .send(true)
            .map_err(|e| ChannelError::Shutdown(format!("failed to send shutdown: {e}")))?;
        Ok(())
    }
}
