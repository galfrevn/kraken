use std::sync::Arc;
use tokio::sync::{broadcast, watch};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tracing::{info, warn};

use crate::proto::agent::v1::{SchedulerEvent, TriggerType as ProtoTriggerType};
use super::cron_trigger::convert_prost_struct_to_serde_json_value;
use super::engine::TriggerEngine;
use super::types::{TriggerEvent, TriggerType};

pub struct FileWatcherTriggerListener {
    trigger_engine: Arc<TriggerEngine>,
    scheduler_event_receiver: broadcast::Receiver<SchedulerEvent>,
}

impl FileWatcherTriggerListener {
    pub fn new(
        trigger_engine: Arc<TriggerEngine>,
        scheduler_event_receiver: broadcast::Receiver<SchedulerEvent>,
    ) -> Self {
        Self {
            trigger_engine,
            scheduler_event_receiver,
        }
    }

    pub async fn run(self, mut shutdown_receiver: watch::Receiver<bool>) {
        let trigger_engine = self.trigger_engine;
        let broadcast_stream = BroadcastStream::new(self.scheduler_event_receiver);
        tokio::pin!(broadcast_stream);

        info!("file watcher trigger listener started");

        loop {
            tokio::select! {
                maybe_event = broadcast_stream.next() => {
                    match maybe_event {
                        Some(Ok(scheduler_event)) => {
                            Self::process_scheduler_event(&trigger_engine, scheduler_event).await;
                        }
                        Some(Err(lagged_error)) => {
                            warn!(
                                error = %lagged_error,
                                "file watcher trigger listener dropped lagged broadcast messages"
                            );
                        }
                        None => {
                            info!("file watcher trigger listener broadcast channel closed");
                            break;
                        }
                    }
                }
                _ = shutdown_receiver.changed() => {
                    info!("file watcher trigger listener shutting down");
                    break;
                }
            }
        }
    }

    async fn process_scheduler_event(trigger_engine: &TriggerEngine, scheduler_event: SchedulerEvent) {
        let proto_trigger_type = ProtoTriggerType::try_from(scheduler_event.trigger_type);
        if proto_trigger_type != Ok(ProtoTriggerType::FileChange) {
            return;
        }

        let payload_as_json = match scheduler_event.payload {
            Some(prost_struct) => convert_prost_struct_to_serde_json_value(prost_struct),
            None => serde_json::Value::Object(serde_json::Map::new()),
        };

        let fired_at = scheduler_event
            .timestamp
            .map(|timestamp| {
                chrono::DateTime::from_timestamp(timestamp.seconds, timestamp.nanos as u32)
                    .unwrap_or_else(chrono::Utc::now)
            })
            .unwrap_or_else(chrono::Utc::now);

        let trigger_event = TriggerEvent {
            id: scheduler_event.id,
            trigger_type: TriggerType::FileChange,
            source: scheduler_event.source.clone(),
            payload: payload_as_json,
            fired_at,
        };

        let maybe_task_id = trigger_engine.handle_trigger_event(trigger_event).await;

        if let Some(created_task_id) = maybe_task_id {
            info!(
                task_id = %created_task_id,
                source = %scheduler_event.source,
                "file watcher trigger listener created task from scheduler event"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_change_event_filtering_accepts_file_change_trigger_type() {
        let file_change_scheduler_event = SchedulerEvent {
            id: "test-id".to_string(),
            trigger_type: ProtoTriggerType::FileChange.into(),
            source: "watcher:src-watcher".to_string(),
            payload: None,
            timestamp: None,
        };

        let proto_trigger_type =
            ProtoTriggerType::try_from(file_change_scheduler_event.trigger_type);
        assert_eq!(proto_trigger_type, Ok(ProtoTriggerType::FileChange));
    }

    #[test]
    fn test_file_change_event_filtering_rejects_cron_trigger_type() {
        let cron_scheduler_event = SchedulerEvent {
            id: "test-id".to_string(),
            trigger_type: ProtoTriggerType::Cron.into(),
            source: "cron:daily-check".to_string(),
            payload: None,
            timestamp: None,
        };

        let proto_trigger_type =
            ProtoTriggerType::try_from(cron_scheduler_event.trigger_type);
        assert_ne!(proto_trigger_type, Ok(ProtoTriggerType::FileChange));
    }

    #[test]
    fn test_file_change_event_filtering_rejects_webhook_trigger_type() {
        let webhook_scheduler_event = SchedulerEvent {
            id: "test-id".to_string(),
            trigger_type: ProtoTriggerType::Webhook.into(),
            source: "webhook:github".to_string(),
            payload: None,
            timestamp: None,
        };

        let proto_trigger_type =
            ProtoTriggerType::try_from(webhook_scheduler_event.trigger_type);
        assert_ne!(proto_trigger_type, Ok(ProtoTriggerType::FileChange));
    }

    #[test]
    fn test_trigger_event_creation_from_file_change_scheduler_event() {
        let scheduler_event = SchedulerEvent {
            id: "event-789".to_string(),
            trigger_type: ProtoTriggerType::FileChange.into(),
            source: "watcher:config-watcher".to_string(),
            payload: None,
            timestamp: Some(prost_types::Timestamp {
                seconds: 1710400000,
                nanos: 0,
            }),
        };

        let payload_as_json = match scheduler_event.payload {
            Some(prost_struct) => convert_prost_struct_to_serde_json_value(prost_struct),
            None => serde_json::Value::Object(serde_json::Map::new()),
        };

        let fired_at = scheduler_event
            .timestamp
            .map(|timestamp| {
                chrono::DateTime::from_timestamp(timestamp.seconds, timestamp.nanos as u32)
                    .unwrap_or_else(chrono::Utc::now)
            })
            .unwrap_or_else(chrono::Utc::now);

        let trigger_event = TriggerEvent {
            id: scheduler_event.id.clone(),
            trigger_type: TriggerType::FileChange,
            source: scheduler_event.source.clone(),
            payload: payload_as_json,
            fired_at,
        };

        assert_eq!(trigger_event.id, "event-789");
        assert_eq!(trigger_event.trigger_type, TriggerType::FileChange);
        assert_eq!(trigger_event.source, "watcher:config-watcher");
        assert!(trigger_event.payload.is_object());
        assert_eq!(trigger_event.payload.as_object().unwrap().len(), 0);
    }

    #[test]
    fn test_trigger_event_creation_from_file_change_event_with_payload() {
        let mut fields = std::collections::BTreeMap::new();
        fields.insert(
            "changed_path".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue(
                    "src/main.rs".to_string(),
                )),
            },
        );

        let scheduler_event = SchedulerEvent {
            id: "event-abc".to_string(),
            trigger_type: ProtoTriggerType::FileChange.into(),
            source: "watcher:src-watcher".to_string(),
            payload: Some(prost_types::Struct { fields }),
            timestamp: None,
        };

        let payload_as_json = match scheduler_event.payload {
            Some(prost_struct) => convert_prost_struct_to_serde_json_value(prost_struct),
            None => serde_json::Value::Object(serde_json::Map::new()),
        };

        let trigger_event = TriggerEvent {
            id: scheduler_event.id.clone(),
            trigger_type: TriggerType::FileChange,
            source: scheduler_event.source.clone(),
            payload: payload_as_json,
            fired_at: chrono::Utc::now(),
        };

        assert_eq!(trigger_event.payload["changed_path"], "src/main.rs");
    }
}
