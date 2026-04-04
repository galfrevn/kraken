use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const DEFAULT_BROADCAST_CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DaemonEventType {
    TaskStarted,
    TaskCompleted,
    TaskFailed,
    TaskCancelled,
    TriggerFired,
    PullRequestCreated,
    DailyDigest,
    CostWarning,
    RateLimitExceeded,
    ChannelMessageReceived,
    ChannelMessageSent,
}

impl DaemonEventType {
    pub fn from_string(value: &str) -> Option<Self> {
        match value {
            "task.started" => Some(Self::TaskStarted),
            "task.completed" => Some(Self::TaskCompleted),
            "task.failed" => Some(Self::TaskFailed),
            "task.cancelled" => Some(Self::TaskCancelled),
            "trigger.fired" => Some(Self::TriggerFired),
            "pr.created" => Some(Self::PullRequestCreated),
            "daily.digest" => Some(Self::DailyDigest),
            "cost.warning" => Some(Self::CostWarning),
            "rate_limit.exceeded" => Some(Self::RateLimitExceeded),
            "channel.message_received" => Some(Self::ChannelMessageReceived),
            "channel.message_sent" => Some(Self::ChannelMessageSent),
            _ => None,
        }
    }

    pub fn as_topic(&self) -> &'static str {
        match self {
            Self::TaskStarted => "task.started",
            Self::TaskCompleted => "task.completed",
            Self::TaskFailed => "task.failed",
            Self::TaskCancelled => "task.cancelled",
            Self::TriggerFired => "trigger.fired",
            Self::PullRequestCreated => "pr.created",
            Self::DailyDigest => "daily.digest",
            Self::CostWarning => "cost.warning",
            Self::RateLimitExceeded => "rate_limit.exceeded",
            Self::ChannelMessageReceived => "channel.message_received",
            Self::ChannelMessageSent => "channel.message_sent",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DaemonEvent {
    pub event_type: DaemonEventType,
    pub task_id: String,
    pub task_name: String,
    pub summary: String,
    pub details: HashMap<String, String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone)]
pub struct EventBroadcaster {
    sender: Arc<broadcast::Sender<DaemonEvent>>,
}

impl EventBroadcaster {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(DEFAULT_BROADCAST_CHANNEL_CAPACITY);
        Self {
            sender: Arc::new(sender),
        }
    }

    pub fn publish(&self, event: DaemonEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DaemonEvent> {
        self.sender.subscribe()
    }
}
