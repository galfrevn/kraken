use std::sync::Arc;
use tokio::sync::{broadcast, watch};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tracing::{info, warn};

use crate::proto::agent::v1::{SchedulerEvent, TriggerType as ProtoTriggerType};
use super::engine::TriggerEngine;
use super::types::{TriggerEvent, TriggerType};

pub struct CronTriggerListener {
    trigger_engine: Arc<TriggerEngine>,
    scheduler_event_receiver: broadcast::Receiver<SchedulerEvent>,
}

impl CronTriggerListener {
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

        info!("cron trigger listener started");

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
                                "cron trigger listener dropped lagged broadcast messages"
                            );
                        }
                        None => {
                            info!("cron trigger listener broadcast channel closed");
                            break;
                        }
                    }
                }
                _ = shutdown_receiver.changed() => {
                    info!("cron trigger listener shutting down");
                    break;
                }
            }
        }
    }

    async fn process_scheduler_event(trigger_engine: &TriggerEngine, scheduler_event: SchedulerEvent) {
        let proto_trigger_type = ProtoTriggerType::try_from(scheduler_event.trigger_type);
        if proto_trigger_type != Ok(ProtoTriggerType::Cron) {
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
            trigger_type: TriggerType::Cron,
            source: scheduler_event.source.clone(),
            payload: payload_as_json,
            fired_at,
        };

        let maybe_task_id = trigger_engine.handle_trigger_event(trigger_event).await;

        if let Some(created_task_id) = maybe_task_id {
            info!(
                task_id = %created_task_id,
                source = %scheduler_event.source,
                "cron trigger listener created task from scheduler event"
            );
        }
    }
}

pub fn convert_prost_struct_to_serde_json_value(
    prost_struct: prost_types::Struct,
) -> serde_json::Value {
    let mut json_map = serde_json::Map::new();
    for (field_name, prost_value) in prost_struct.fields {
        json_map.insert(
            field_name,
            convert_prost_value_to_serde_json_value(prost_value),
        );
    }
    serde_json::Value::Object(json_map)
}

fn convert_prost_value_to_serde_json_value(prost_value: prost_types::Value) -> serde_json::Value {
    match prost_value.kind {
        Some(prost_types::value::Kind::NullValue(_)) => serde_json::Value::Null,
        Some(prost_types::value::Kind::NumberValue(number)) => {
            serde_json::Value::Number(
                serde_json::Number::from_f64(number).unwrap_or_else(|| serde_json::Number::from(0)),
            )
        }
        Some(prost_types::value::Kind::StringValue(string)) => {
            serde_json::Value::String(string)
        }
        Some(prost_types::value::Kind::BoolValue(boolean)) => {
            serde_json::Value::Bool(boolean)
        }
        Some(prost_types::value::Kind::StructValue(nested_struct)) => {
            convert_prost_struct_to_serde_json_value(nested_struct)
        }
        Some(prost_types::value::Kind::ListValue(list)) => {
            let json_elements: Vec<serde_json::Value> = list
                .values
                .into_iter()
                .map(convert_prost_value_to_serde_json_value)
                .collect();
            serde_json::Value::Array(json_elements)
        }
        None => serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn test_convert_prost_struct_with_string_values_to_serde_json() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "name".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue(
                    "test-cron".to_string(),
                )),
            },
        );
        fields.insert(
            "schedule".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue(
                    "0 9 * * *".to_string(),
                )),
            },
        );

        let prost_struct = prost_types::Struct { fields };
        let json_value = convert_prost_struct_to_serde_json_value(prost_struct);

        assert_eq!(json_value["name"], "test-cron");
        assert_eq!(json_value["schedule"], "0 9 * * *");
    }

    #[test]
    fn test_convert_prost_struct_with_number_value_to_serde_json() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "count".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::NumberValue(42.0)),
            },
        );

        let prost_struct = prost_types::Struct { fields };
        let json_value = convert_prost_struct_to_serde_json_value(prost_struct);

        assert_eq!(json_value["count"], 42.0);
    }

    #[test]
    fn test_convert_prost_struct_with_boolean_value_to_serde_json() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "enabled".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::BoolValue(true)),
            },
        );

        let prost_struct = prost_types::Struct { fields };
        let json_value = convert_prost_struct_to_serde_json_value(prost_struct);

        assert_eq!(json_value["enabled"], true);
    }

    #[test]
    fn test_convert_prost_struct_with_null_value_to_serde_json() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "empty".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::NullValue(0)),
            },
        );

        let prost_struct = prost_types::Struct { fields };
        let json_value = convert_prost_struct_to_serde_json_value(prost_struct);

        assert!(json_value["empty"].is_null());
    }

    #[test]
    fn test_convert_prost_struct_with_nested_struct_to_serde_json() {
        let mut inner_fields = BTreeMap::new();
        inner_fields.insert(
            "key".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue("value".to_string())),
            },
        );

        let mut outer_fields = BTreeMap::new();
        outer_fields.insert(
            "nested".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StructValue(prost_types::Struct {
                    fields: inner_fields,
                })),
            },
        );

        let prost_struct = prost_types::Struct {
            fields: outer_fields,
        };
        let json_value = convert_prost_struct_to_serde_json_value(prost_struct);

        assert_eq!(json_value["nested"]["key"], "value");
    }

    #[test]
    fn test_convert_prost_struct_with_list_value_to_serde_json() {
        let list_values = vec![
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue("a".to_string())),
            },
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue("b".to_string())),
            },
        ];

        let mut fields = BTreeMap::new();
        fields.insert(
            "items".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::ListValue(
                    prost_types::ListValue {
                        values: list_values,
                    },
                )),
            },
        );

        let prost_struct = prost_types::Struct { fields };
        let json_value = convert_prost_struct_to_serde_json_value(prost_struct);

        let items = json_value["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], "a");
        assert_eq!(items[1], "b");
    }

    #[test]
    fn test_convert_prost_struct_empty_to_serde_json() {
        let prost_struct = prost_types::Struct {
            fields: BTreeMap::new(),
        };
        let json_value = convert_prost_struct_to_serde_json_value(prost_struct);

        assert!(json_value.is_object());
        assert_eq!(json_value.as_object().unwrap().len(), 0);
    }

    #[test]
    fn test_convert_prost_value_with_no_kind_to_serde_json_null() {
        let prost_value = prost_types::Value { kind: None };
        let json_value = convert_prost_value_to_serde_json_value(prost_value);

        assert!(json_value.is_null());
    }

    #[test]
    fn test_cron_event_filtering_accepts_cron_trigger_type() {
        let cron_scheduler_event = SchedulerEvent {
            id: "test-id".to_string(),
            trigger_type: ProtoTriggerType::Cron.into(),
            source: "cron:daily-check".to_string(),
            payload: None,
            timestamp: None,
        };

        let proto_trigger_type =
            ProtoTriggerType::try_from(cron_scheduler_event.trigger_type);
        assert_eq!(proto_trigger_type, Ok(ProtoTriggerType::Cron));
    }

    #[test]
    fn test_cron_event_filtering_rejects_file_change_trigger_type() {
        let file_change_scheduler_event = SchedulerEvent {
            id: "test-id".to_string(),
            trigger_type: ProtoTriggerType::FileChange.into(),
            source: "watcher:src-watcher".to_string(),
            payload: None,
            timestamp: None,
        };

        let proto_trigger_type =
            ProtoTriggerType::try_from(file_change_scheduler_event.trigger_type);
        assert_ne!(proto_trigger_type, Ok(ProtoTriggerType::Cron));
    }

    #[test]
    fn test_cron_event_filtering_rejects_webhook_trigger_type() {
        let webhook_scheduler_event = SchedulerEvent {
            id: "test-id".to_string(),
            trigger_type: ProtoTriggerType::Webhook.into(),
            source: "webhook:github".to_string(),
            payload: None,
            timestamp: None,
        };

        let proto_trigger_type =
            ProtoTriggerType::try_from(webhook_scheduler_event.trigger_type);
        assert_ne!(proto_trigger_type, Ok(ProtoTriggerType::Cron));
    }

    #[test]
    fn test_trigger_event_creation_from_cron_scheduler_event() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "param1".to_string(),
            prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue("value1".to_string())),
            },
        );

        let scheduler_event = SchedulerEvent {
            id: "event-123".to_string(),
            trigger_type: ProtoTriggerType::Cron.into(),
            source: "cron:nightly-build".to_string(),
            payload: Some(prost_types::Struct { fields }),
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
            trigger_type: TriggerType::Cron,
            source: scheduler_event.source.clone(),
            payload: payload_as_json,
            fired_at,
        };

        assert_eq!(trigger_event.id, "event-123");
        assert_eq!(trigger_event.trigger_type, TriggerType::Cron);
        assert_eq!(trigger_event.source, "cron:nightly-build");
        assert_eq!(trigger_event.payload["param1"], "value1");
    }

    #[test]
    fn test_trigger_event_creation_from_cron_event_without_payload() {
        let scheduler_event = SchedulerEvent {
            id: "event-456".to_string(),
            trigger_type: ProtoTriggerType::Cron.into(),
            source: "cron:simple-job".to_string(),
            payload: None,
            timestamp: None,
        };

        let payload_as_json = match scheduler_event.payload {
            Some(prost_struct) => convert_prost_struct_to_serde_json_value(prost_struct),
            None => serde_json::Value::Object(serde_json::Map::new()),
        };

        let trigger_event = TriggerEvent {
            id: scheduler_event.id.clone(),
            trigger_type: TriggerType::Cron,
            source: scheduler_event.source.clone(),
            payload: payload_as_json,
            fired_at: chrono::Utc::now(),
        };

        assert_eq!(trigger_event.id, "event-456");
        assert!(trigger_event.payload.is_object());
        assert_eq!(trigger_event.payload.as_object().unwrap().len(), 0);
    }
}
