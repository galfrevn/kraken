use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{debug, error, info, warn};

use crate::db::channel_sessions::ChannelSessionStore;
use crate::events::{DaemonEvent, DaemonEventType, EventBroadcaster};

use super::telegram::markdown_to_telegram_html;
use super::types::{ChannelAdapter, InboundMessage, MessageContent};
use super::worker_manager::{ChannelWorkerManager, StreamEvent};

type AdapterMap = HashMap<String, Arc<dyn ChannelAdapter>>;

const MAX_TELEGRAM_MESSAGE_LENGTH: usize = 4096;
const DRAFT_UPDATE_INTERVAL_MS: u64 = 300;
const MIN_CHARS_BEFORE_DRAFT: usize = 15;

pub struct ChannelRouter {
    adapters: Vec<Box<dyn ChannelAdapter>>,
    session_store: Arc<ChannelSessionStore>,
    worker_manager: Arc<ChannelWorkerManager>,
    event_broadcaster: EventBroadcaster,
}

impl ChannelRouter {
    pub fn new(
        session_store: Arc<ChannelSessionStore>,
        worker_manager: Arc<ChannelWorkerManager>,
        event_broadcaster: EventBroadcaster,
    ) -> Self {
        Self {
            adapters: Vec::new(),
            session_store,
            worker_manager,
            event_broadcaster,
        }
    }

    pub fn add_adapter(&mut self, adapter: Box<dyn ChannelAdapter>) {
        info!(
            channel_type = adapter.channel_type(),
            "registered channel adapter"
        );
        self.adapters.push(adapter);
    }

    pub async fn start(self) -> Result<Arc<ChannelRouterHandle>, String> {
        let (message_tx, message_rx) = mpsc::channel::<InboundMessage>(256);

        let mut adapter_map: AdapterMap = HashMap::new();

        for adapter in self.adapters {
            adapter.start(message_tx.clone()).await.map_err(|error| {
                format!(
                    "failed to start {} adapter: {error}",
                    adapter.channel_type()
                )
            })?;

            info!(
                channel_type = adapter.channel_type(),
                "channel adapter started"
            );

            let channel_type = adapter.channel_type().to_string();
            let shared_adapter: Arc<dyn ChannelAdapter> = Arc::from(adapter);
            adapter_map.insert(channel_type, shared_adapter);
        }

        let shared_adapters = Arc::new(adapter_map);

        let handle = Arc::new(ChannelRouterHandle {
            adapters: Arc::clone(&shared_adapters),
        });

        let session_store = self.session_store;
        let worker_manager = self.worker_manager;
        let event_broadcaster = self.event_broadcaster;

        tokio::spawn(async move {
            process_inbound_messages(
                message_rx,
                session_store,
                worker_manager,
                event_broadcaster,
                shared_adapters,
            )
            .await;
        });

        Ok(handle)
    }
}

pub struct ChannelRouterHandle {
    adapters: Arc<AdapterMap>,
}

#[allow(dead_code)]
impl ChannelRouterHandle {
    pub async fn shutdown(&self) {
        for adapter in self.adapters.values() {
            if let Err(error) = adapter.shutdown().await {
                warn!(
                    channel_type = adapter.channel_type(),
                    error = %error,
                    "error shutting down channel adapter"
                );
            }
        }
    }

    pub fn adapter_count(&self) -> usize {
        self.adapters.len()
    }

    pub fn adapter_types(&self) -> Vec<&str> {
        self.adapters.values().map(|a| a.channel_type()).collect()
    }
}

async fn process_inbound_messages(
    mut message_rx: mpsc::Receiver<InboundMessage>,
    session_store: Arc<ChannelSessionStore>,
    worker_manager: Arc<ChannelWorkerManager>,
    event_broadcaster: EventBroadcaster,
    adapters: Arc<AdapterMap>,
) {
    info!("channel message processor started");

    while let Some(inbound) = message_rx.recv().await {
        let session_store = Arc::clone(&session_store);
        let worker_manager = Arc::clone(&worker_manager);
        let event_broadcaster = event_broadcaster.clone();
        let adapters = Arc::clone(&adapters);

        tokio::spawn(async move {
            handle_single_message(
                inbound,
                session_store,
                worker_manager,
                event_broadcaster,
                adapters,
            )
            .await;
        });
    }

    info!("channel message processor stopped");
}

async fn handle_single_message(
    inbound: InboundMessage,
    session_store: Arc<ChannelSessionStore>,
    worker_manager: Arc<ChannelWorkerManager>,
    event_broadcaster: EventBroadcaster,
    adapters: Arc<AdapterMap>,
) {
    let channel_type = &inbound.channel_type;
    let chat_id = &inbound.chat_id;

    info!(
        channel_type = channel_type,
        chat_id = chat_id,
        text_len = inbound.text.len(),
        "processing inbound channel message"
    );

    let session = match session_store
        .get_or_create_session(channel_type, chat_id)
        .await
    {
        Ok(session) => session,
        Err(error) => {
            error!(
                channel_type = channel_type,
                chat_id = chat_id,
                error = %error,
                "failed to resolve channel session"
            );
            return;
        }
    };

    publish_channel_event(
        &event_broadcaster,
        DaemonEventType::ChannelMessageReceived,
        channel_type,
        chat_id,
        &inbound.text,
    );

    let adapter = match adapters.get(channel_type) {
        Some(adapter) => adapter,
        None => {
            error!(
                channel_type = channel_type,
                "no adapter found for channel type"
            );
            return;
        }
    };

    if let Err(error) = worker_manager.ensure_running().await {
        error!(error = %error, "channel worker not available");
        let _ = adapter
            .send_message(chat_id, MessageContent::Error("Worker unavailable".into()))
            .await;
        return;
    }

    let typing_adapter = Arc::clone(adapter);
    let typing_chat_id = chat_id.to_string();
    let typing_cancel = tokio_util::sync::CancellationToken::new();
    let typing_cancel_clone = typing_cancel.clone();

    tokio::spawn(async move {
        loop {
            let _ = typing_adapter.send_typing(&typing_chat_id).await;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(4)) => {}
                _ = typing_cancel_clone.cancelled() => break,
            }
        }
    });

    let response = match worker_manager
        .send_message_stream(&session.session_id, &inbound.text)
        .await
    {
        Ok(rx) => stream_response_to_channel(adapter, chat_id, rx, &typing_cancel).await,
        Err(error) => {
            error!(
                session_id = session.session_id,
                error = %error,
                "channel worker failed to start stream"
            );
            typing_cancel.cancel();
            let error_msg = format!("Error: {error}");
            let _ = adapter
                .send_message(chat_id, MessageContent::Error(error_msg.clone()))
                .await;
            error_msg
        }
    };

    if let Err(error) = session_store
        .update_last_message(channel_type, chat_id)
        .await
    {
        warn!(error = %error, "failed to update last_message_at");
    }

    publish_channel_event(
        &event_broadcaster,
        DaemonEventType::ChannelMessageSent,
        channel_type,
        chat_id,
        &response,
    );

    info!(
        channel_type = channel_type,
        chat_id = chat_id,
        response_len = response.len(),
        "channel message processed"
    );
}

async fn stream_response_to_channel(
    adapter: &Arc<dyn ChannelAdapter>,
    chat_id: &str,
    mut rx: mpsc::Receiver<StreamEvent>,
    typing_cancel: &tokio_util::sync::CancellationToken,
) -> String {
    let mut accumulated = String::new();
    let draft_id = (std::process::id() as i32)
        .wrapping_mul(chat_id.len() as i32)
        .wrapping_add(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as i32,
        )
        .abs()
        .max(1);
    let mut draft_active = false;
    let mut last_draft_update = Instant::now();
    let draft_interval = std::time::Duration::from_millis(DRAFT_UPDATE_INTERVAL_MS);

    while let Some(event) = rx.recv().await {
        match event {
            StreamEvent::Delta(delta) => {
                accumulated.push_str(&delta);

                let should_send = accumulated.len() >= MIN_CHARS_BEFORE_DRAFT
                    && last_draft_update.elapsed() >= draft_interval;

                if should_send {
                    let draft_text =
                        truncate_to_char_boundary(&accumulated, MAX_TELEGRAM_MESSAGE_LENGTH);
                    match adapter
                        .send_draft(chat_id, draft_id, draft_text, None)
                        .await
                    {
                        Ok(()) => {
                            if !draft_active {
                                typing_cancel.cancel();
                                draft_active = true;
                                debug!("draft streaming started");
                            }
                            last_draft_update = Instant::now();
                        }
                        Err(error) => {
                            debug!(error = %error, "send_draft failed, will retry");
                        }
                    }
                }
            }
            StreamEvent::Typing => {
                if !draft_active {
                    let _ = adapter.send_typing(chat_id).await;
                }
            }
            StreamEvent::Done(full_text) => {
                accumulated = full_text;
                break;
            }
            StreamEvent::Error(error) => {
                warn!(error = %error, "stream error from worker");
                if accumulated.is_empty() {
                    accumulated = format!("Error: {error}");
                }
                break;
            }
        }
    }

    typing_cancel.cancel();

    let html = markdown_to_telegram_html(&accumulated);

    if html.len() <= MAX_TELEGRAM_MESSAGE_LENGTH {
        let _ = adapter
            .send_message(chat_id, MessageContent::Html(html))
            .await;
    } else {
        for chunk in split_html_message(&html, MAX_TELEGRAM_MESSAGE_LENGTH) {
            let _ = adapter
                .send_message(chat_id, MessageContent::Html(chunk))
                .await;
        }
    }

    accumulated
}

fn truncate_to_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn split_html_message(text: &str, max_len: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut remaining = text;

    while remaining.len() > max_len {
        let split_at = remaining[..max_len]
            .rfind('\n')
            .unwrap_or_else(|| remaining[..max_len].rfind(' ').unwrap_or(max_len));
        chunks.push(remaining[..split_at].to_string());
        remaining = remaining[split_at..].trim_start();
    }

    if !remaining.is_empty() {
        chunks.push(remaining.to_string());
    }

    chunks
}

fn publish_channel_event(
    event_broadcaster: &EventBroadcaster,
    event_type: DaemonEventType,
    channel_type: &str,
    chat_id: &str,
    text: &str,
) {
    let mut details = HashMap::new();
    details.insert("channel_type".to_string(), channel_type.to_string());
    details.insert("chat_id".to_string(), chat_id.to_string());

    let summary = if text.len() > 100 {
        format!("{}...", &text[..100])
    } else {
        text.to_string()
    };

    event_broadcaster.publish(DaemonEvent {
        event_type,
        task_id: format!("channel-{channel_type}-{chat_id}"),
        task_name: format!("channel-{channel_type}"),
        summary,
        details,
        timestamp: chrono::Utc::now(),
    });
}
