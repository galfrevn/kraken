use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use reqwest::Client as HttpClient;
use teloxide::prelude::*;
use teloxide::types::{BotCommand, ChatAction, MessageId, ParseMode};
use tokio::sync::{mpsc, watch};
use tracing::{error, info, warn};

use crate::daemon::config::DmPolicy;
use crate::db::channel_users::ChannelUserStore;

use super::types::{ChannelAdapter, ChannelError, InboundMessage, MessageContent};

const TELEGRAM_MAX_MESSAGE_LENGTH: usize = 4096;

pub struct TelegramAdapter {
    token: String,
    dm_policy: DmPolicy,
    allow_from: Vec<i64>,
    user_store: Option<Arc<ChannelUserStore>>,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
}

impl TelegramAdapter {
    pub fn new(token: String, dm_policy: DmPolicy, allow_from: Vec<i64>) -> Self {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        Self {
            token,
            dm_policy,
            allow_from,
            user_store: None,
            shutdown_tx,
            shutdown_rx,
        }
    }

    pub fn with_user_store(mut self, user_store: Arc<ChannelUserStore>) -> Self {
        self.user_store = Some(user_store);
        self
    }

    fn create_bot(&self) -> Bot {
        Bot::new(&self.token)
    }
}

fn content_to_html(content: MessageContent) -> String {
    match content {
        MessageContent::Text(text) => markdown_to_telegram_html(&text),
        MessageContent::Html(html) => html,
        MessageContent::Error(error_text) => format!("⚠️ {}", html_escape(&error_text)),
    }
}

fn parse_chat_id(chat_id: &str) -> Result<ChatId, ChannelError> {
    let parsed: i64 = chat_id
        .parse()
        .map_err(|_| ChannelError::SendFailed(format!("invalid chat_id: {chat_id}")))?;
    Ok(ChatId(parsed))
}

#[async_trait]
impl ChannelAdapter for TelegramAdapter {
    fn channel_type(&self) -> &str {
        "telegram"
    }

    async fn start(&self, message_tx: mpsc::Sender<InboundMessage>) -> Result<(), ChannelError> {
        let bot = self.create_bot();
        let dm_policy = self.dm_policy;
        let allow_from = self.allow_from.clone();
        let user_store = self.user_store.clone();
        let mut shutdown_rx = self.shutdown_rx.clone();

        info!(dm_policy = ?dm_policy, "starting telegram long polling");

        // Register slash commands in Telegram's command menu
        let menu_bot = bot.clone();
        let _ = menu_bot
            .set_my_commands(vec![
                BotCommand::new("task", "Run a background task"),
                BotCommand::new("new", "Start a new conversation"),
                BotCommand::new("model", "Show or change the current model"),
                BotCommand::new("agent", "Show or switch agent (build/plan)"),
                BotCommand::new("cost", "Show usage and costs"),
                BotCommand::new("status", "Show daemon status"),
                BotCommand::new("repos", "List configured repos"),
                BotCommand::new("users", "List authorized users"),
                BotCommand::new("help", "List all commands"),
            ])
            .await
            .inspect_err(|e| warn!(error = %e, "failed to register bot commands"));

        tokio::spawn(async move {
            let handler = Update::filter_message().endpoint(
                move |bot: Bot, msg: Message, message_tx: mpsc::Sender<InboundMessage>| {
                    let allow_from = allow_from.clone();
                    let user_store = user_store.clone();
                    async move {
                        let sender = msg.from.as_ref();
                        let sender_id = sender.map(|user| user.id.0 as i64).unwrap_or(0);

                        match dm_policy {
                            DmPolicy::Disabled => {
                                return respond(());
                            }
                            DmPolicy::Allowlist => {
                                if !allow_from.contains(&sender_id) {
                                    warn!(
                                        sender_id = sender_id,
                                        "ignoring message from non-allowed user"
                                    );
                                    return respond(());
                                }
                            }
                            DmPolicy::Pairing => {
                                if let Some(ref store) = user_store {
                                    let platform_id = sender_id.to_string();
                                    match store.is_authorized("telegram", &platform_id).await {
                                        Ok(true) => { /* authorized, continue */ }
                                        Ok(false) => {
                                            handle_pairing_request(&bot, &msg, sender_id, store)
                                                .await;
                                            return respond(());
                                        }
                                        Err(err) => {
                                            error!(error = %err, "failed to check authorization");
                                            return respond(());
                                        }
                                    }
                                } else {
                                    // No user_store — fall back to allow_from check
                                    if !allow_from.is_empty() && !allow_from.contains(&sender_id) {
                                        warn!(
                                            sender_id = sender_id,
                                            "ignoring message from unauthorized user"
                                        );
                                        return respond(());
                                    }
                                }
                            }
                        }

                        let text = match msg.text() {
                            Some(text) => text.to_string(),
                            None => return respond(()),
                        };

                        let chat_id = msg.chat.id.0.to_string();

                        let inbound = InboundMessage {
                            channel_type: "telegram".to_string(),
                            chat_id,
                            sender_id: sender_id.to_string(),
                            text,
                            timestamp: chrono::Utc::now(),
                            metadata: HashMap::new(),
                        };

                        if let Err(send_error) = message_tx.send(inbound).await {
                            error!(error = %send_error, "failed to forward telegram message");
                        }

                        respond(())
                    }
                },
            );

            let mut dispatcher = Dispatcher::builder(bot, handler)
                .dependencies(dptree::deps![message_tx])
                .enable_ctrlc_handler()
                .build();

            tokio::select! {
                _ = dispatcher.dispatch() => {
                    info!("telegram dispatcher stopped");
                }
                _ = shutdown_rx.changed() => {
                    info!("telegram adapter received shutdown signal");
                    match dispatcher.shutdown_token().shutdown() {
                        Ok(shutdown_future) => shutdown_future.await,
                        Err(err) => {
                            error!(error = %err, "failed to initiate telegram dispatcher shutdown");
                        }
                    }
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
        let bot = self.create_bot();
        let telegram_chat_id = parse_chat_id(chat_id)?;
        let html = content_to_html(content);
        let chunks = split_message(&html, TELEGRAM_MAX_MESSAGE_LENGTH);

        for chunk in chunks {
            bot.send_message(telegram_chat_id, &chunk)
                .parse_mode(ParseMode::Html)
                .await
                .map_err(|error| {
                    ChannelError::SendFailed(format!("telegram send error: {error}"))
                })?;
        }

        Ok(())
    }

    async fn send_message_returning_id(
        &self,
        chat_id: &str,
        content: MessageContent,
    ) -> Result<i32, ChannelError> {
        let bot = self.create_bot();
        let telegram_chat_id = parse_chat_id(chat_id)?;
        let html = content_to_html(content);

        let sent = bot
            .send_message(telegram_chat_id, &html)
            .parse_mode(ParseMode::Html)
            .await
            .map_err(|error| ChannelError::SendFailed(format!("telegram send error: {error}")))?;

        Ok(sent.id.0)
    }

    async fn edit_message(
        &self,
        chat_id: &str,
        message_id: i32,
        content: MessageContent,
    ) -> Result<(), ChannelError> {
        let bot = self.create_bot();
        let telegram_chat_id = parse_chat_id(chat_id)?;
        let html = content_to_html(content);

        bot.edit_message_text(telegram_chat_id, MessageId(message_id), &html)
            .parse_mode(ParseMode::Html)
            .await
            .map_err(|error| ChannelError::SendFailed(format!("telegram edit error: {error}")))?;

        Ok(())
    }

    async fn send_typing(&self, chat_id: &str) -> Result<(), ChannelError> {
        let bot = self.create_bot();
        let telegram_chat_id = parse_chat_id(chat_id)?;

        bot.send_chat_action(telegram_chat_id, ChatAction::Typing)
            .await
            .map_err(|error| {
                ChannelError::SendFailed(format!("failed to send typing action: {error}"))
            })?;

        Ok(())
    }

    async fn send_draft(
        &self,
        chat_id: &str,
        draft_id: i32,
        text: &str,
        parse_mode: Option<&str>,
    ) -> Result<(), ChannelError> {
        let telegram_chat_id: i64 = chat_id
            .parse()
            .map_err(|_| ChannelError::SendFailed(format!("invalid chat_id: {chat_id}")))?;

        let mut body = serde_json::json!({
            "chat_id": telegram_chat_id,
            "draft_id": draft_id,
            "text": text,
        });

        if let Some(mode) = parse_mode {
            body["parse_mode"] = serde_json::json!(mode);
        }

        let url = format!(
            "https://api.telegram.org/bot{}/sendMessageDraft",
            self.token
        );

        let response = HttpClient::new()
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| ChannelError::SendFailed(format!("draft request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ChannelError::SendFailed(format!(
                "sendMessageDraft failed ({status}): {text}"
            )));
        }

        Ok(())
    }

    async fn shutdown(&self) -> Result<(), ChannelError> {
        info!("shutting down telegram adapter");
        self.shutdown_tx
            .send(true)
            .map_err(|error| ChannelError::Shutdown(format!("failed to send shutdown: {error}")))?;
        Ok(())
    }
}

async fn handle_pairing_request(
    bot: &Bot,
    msg: &Message,
    sender_id: i64,
    user_store: &ChannelUserStore,
) {
    let display_name = msg.from.as_ref().map(|u| u.first_name.clone());

    let platform_id = sender_id.to_string();

    // Check pending count before attempting to create (avoids fragile string matching)
    let pending_count = user_store
        .get_pending_requests("telegram")
        .await
        .map(|r| r.len())
        .unwrap_or(0);

    if pending_count >= 3 {
        warn!(
            sender_id = sender_id,
            "too many pending pairing requests, ignoring"
        );
        return;
    }

    match user_store
        .create_pairing_request("telegram", &platform_id, display_name.as_deref())
        .await
    {
        Ok(code) => {
            let text = format!(
                "🔐 Pairing required\n\n\
                 Your code: {code}\n\n\
                 Share this code with the Kraken owner to get access.\n\
                 This code expires in 1 hour.",
            );
            if let Err(err) = bot.send_message(msg.chat.id, text).await {
                error!(error = %err, "failed to send pairing code to user");
            }
        }
        Err(err) => {
            error!(error = %err, "failed to create pairing request");
        }
    }
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

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn markdown_to_telegram_html(text: &str) -> String {
    let mut result = String::new();
    let mut in_code_block = false;
    let mut code_block_content = String::new();
    let mut code_block_lang = String::new();

    for line in text.lines() {
        if let Some(after_fence) = line.strip_prefix("```") {
            if in_code_block {
                if code_block_lang.is_empty() {
                    result.push_str(&format!("<pre>{}</pre>", html_escape(&code_block_content)));
                } else {
                    result.push_str(&format!(
                        "<pre><code class=\"language-{}\">{}</code></pre>",
                        html_escape(&code_block_lang),
                        html_escape(&code_block_content)
                    ));
                }
                code_block_content.clear();
                code_block_lang.clear();
                in_code_block = false;
            } else {
                code_block_lang = after_fence.trim().to_string();
                in_code_block = true;
            }
            continue;
        }

        if in_code_block {
            if !code_block_content.is_empty() {
                code_block_content.push('\n');
            }
            code_block_content.push_str(line);
            continue;
        }

        let escaped = html_escape(line);
        let formatted = convert_inline_markdown(&escaped);
        result.push_str(&formatted);
        result.push('\n');
    }

    if in_code_block {
        result.push_str(&format!("<pre>{}</pre>", html_escape(&code_block_content)));
    }

    result.trim_end().to_string()
}

fn convert_inline_markdown(text: &str) -> String {
    let mut result = String::new();
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if i + 1 < len
            && chars[i] == '*'
            && chars[i + 1] == '*'
            && let Some(end) = find_closing_double(&chars, i + 2)
        {
            let inner: String = chars[i + 2..end].iter().collect();
            result.push_str(&format!("<b>{inner}</b>"));
            i = end + 2;
            continue;
        }

        if chars[i] == '*'
            && (i == 0 || chars[i - 1] != '*')
            && i + 1 < len
            && chars[i + 1] != '*'
            && let Some(end) = find_closing_single(&chars, i + 1, '*')
            && (end + 1 >= len || chars[end + 1] != '*')
        {
            let inner: String = chars[i + 1..end].iter().collect();
            result.push_str(&format!("<i>{inner}</i>"));
            i = end + 1;
            continue;
        }

        if chars[i] == '`'
            && let Some(end) = find_closing_single(&chars, i + 1, '`')
        {
            let inner: String = chars[i + 1..end].iter().collect();
            result.push_str(&format!("<code>{inner}</code>"));
            i = end + 1;
            continue;
        }

        result.push(chars[i]);
        i += 1;
    }

    result
}

fn find_closing_double(chars: &[char], start: usize) -> Option<usize> {
    (start..chars.len().saturating_sub(1)).find(|&j| chars[j] == '*' && chars[j + 1] == '*')
}

fn find_closing_single(chars: &[char], start: usize, marker: char) -> Option<usize> {
    (start..chars.len()).find(|&j| chars[j] == marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_message_short_text() {
        let chunks = split_message("hello", 4096);
        assert_eq!(chunks, vec!["hello"]);
    }

    #[test]
    fn split_message_over_limit() {
        let text = "a".repeat(5000);
        let chunks = split_message(&text, 4096);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 4096);
        assert_eq!(chunks[1].len(), 904);
    }

    #[test]
    fn markdown_bold() {
        assert_eq!(
            markdown_to_telegram_html("this is **bold** text"),
            "this is <b>bold</b> text"
        );
    }

    #[test]
    fn markdown_italic() {
        assert_eq!(
            markdown_to_telegram_html("this is *italic* text"),
            "this is <i>italic</i> text"
        );
    }

    #[test]
    fn markdown_inline_code() {
        assert_eq!(
            markdown_to_telegram_html("use `println!`"),
            "use <code>println!</code>"
        );
    }

    #[test]
    fn markdown_code_block() {
        let input = "```rust\nfn main() {}\n```";
        let expected = "<pre><code class=\"language-rust\">fn main() {}</code></pre>";
        assert_eq!(markdown_to_telegram_html(input), expected);
    }

    #[test]
    fn markdown_html_escaping() {
        assert_eq!(
            markdown_to_telegram_html("a < b & c > d"),
            "a &lt; b &amp; c &gt; d"
        );
    }

    #[test]
    fn markdown_plain_text() {
        assert_eq!(
            markdown_to_telegram_html("just plain text"),
            "just plain text"
        );
    }

    #[test]
    fn content_to_html_text() {
        let result = content_to_html(MessageContent::Text("hello <world>".into()));
        assert_eq!(result, "hello &lt;world&gt;");
    }

    #[test]
    fn content_to_html_html_passthrough() {
        let result = content_to_html(MessageContent::Html("<b>bold</b>".into()));
        assert_eq!(result, "<b>bold</b>");
    }
}
