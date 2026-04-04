use chrono::Utc;
use cron::Schedule;
use dashmap::DashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{error, info};
use uuid::Uuid;

use crate::types::{CronEntry as CronEntryOutput, SchedulerEvent, TriggerType};

pub struct CronEntry {
    pub id: String,
    pub name: String,
    pub expression: String,
    pub task_template: String,
    pub parameters: std::collections::HashMap<String, String>,
    pub schedule: Schedule,
    pub enabled: bool,
}

pub struct CronEngine {
    entries: Arc<DashMap<String, CronEntry>>,
    event_sender: broadcast::Sender<SchedulerEvent>,
    shutdown: tokio::sync::watch::Sender<bool>,
    last_fired: Arc<DashMap<String, chrono::DateTime<Utc>>>,
}

impl CronEngine {
    pub fn new(event_sender: broadcast::Sender<SchedulerEvent>) -> Self {
        let (shutdown, _) = tokio::sync::watch::channel(false);
        Self {
            entries: Arc::new(DashMap::new()),
            event_sender,
            shutdown,
            last_fired: Arc::new(DashMap::new()),
        }
    }

    pub fn register(
        &self,
        name: String,
        cron_expression: &str,
        task_template: String,
        parameters: std::collections::HashMap<String, String>,
    ) -> Result<(String, String), String> {
        let schedule = Schedule::from_str(cron_expression)
            .map_err(|e| format!("invalid cron expression: {e}"))?;

        let next_run = schedule
            .upcoming(Utc)
            .next()
            .map(|t| t.to_rfc3339())
            .unwrap_or_default();

        let id = Uuid::new_v4().to_string();

        let entry = CronEntry {
            id: id.clone(),
            name: name.clone(),
            expression: cron_expression.to_string(),
            task_template,
            parameters,
            schedule,
            enabled: true,
        };

        self.entries.insert(id.clone(), entry);
        info!(cron_id = %id, name = %name, "registered cron job");

        Ok((id, next_run))
    }

    pub fn unregister(&self, cron_id: &str) -> bool {
        self.last_fired.remove(cron_id);
        self.entries.remove(cron_id).is_some()
    }

    pub fn list(&self) -> Vec<CronEntryOutput> {
        self.entries
            .iter()
            .map(|entry| {
                let next_run = entry
                    .schedule
                    .upcoming(Utc)
                    .next()
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_default();

                CronEntryOutput {
                    cron_id: entry.id.clone(),
                    name: entry.name.clone(),
                    cron_expression: entry.expression.clone(),
                    task_template: entry.task_template.clone(),
                    next_run,
                    enabled: entry.enabled,
                }
            })
            .collect()
    }

    pub fn start(&self) {
        let entries = self.entries.clone();
        let sender = self.event_sender.clone();
        let last_fired = self.last_fired.clone();
        let mut shutdown_rx = self.shutdown.subscribe();

        tokio::spawn(async move {
            info!("cron engine started");
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
                        let now = Utc::now();
                        for entry in entries.iter() {
                            if !entry.enabled {
                                continue;
                            }
                            if let Some(next) = entry.schedule.upcoming(Utc).next() {
                                let diff = (next - now).num_seconds();
                                if diff <= 0 {
                                    let already_fired = last_fired
                                        .get(&entry.id)
                                        .is_some_and(|last| *last == next);
                                    if already_fired {
                                        continue;
                                    }
                                    last_fired.insert(entry.id.clone(), next);

                                    let payload = serde_json::json!(
                                        entry.parameters.iter()
                                            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                                            .collect::<serde_json::Map<String, serde_json::Value>>()
                                    );

                                    let event = SchedulerEvent {
                                        id: Uuid::new_v4().to_string(),
                                        trigger_type: TriggerType::Cron,
                                        source: format!("cron:{}", entry.name),
                                        payload: Some(payload),
                                        timestamp: now,
                                    };
                                    if let Err(e) = sender.send(event) {
                                        error!(error = %e, "failed to send cron event");
                                    }
                                }
                            }
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        info!("cron engine shutting down");
                        break;
                    }
                }
            }
        });
    }

    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
}
