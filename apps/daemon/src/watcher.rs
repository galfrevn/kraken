use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event};
use dashmap::DashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tracing::{info, error};
use uuid::Uuid;

use crate::proto::agent::v1::{SchedulerEvent, TriggerType};

#[allow(dead_code)]
pub struct WatcherEntry {
    id: String,
    name: String,
    paths: Vec<String>,
    ignore_patterns: Vec<String>,
    debounce_ms: u32,
}

pub struct FileWatcherEngine {
    entries: Arc<DashMap<String, WatcherEntry>>,
    event_sender: broadcast::Sender<SchedulerEvent>,
    watchers: Arc<DashMap<String, RecommendedWatcher>>,
}

impl FileWatcherEngine {
    pub fn new(event_sender: broadcast::Sender<SchedulerEvent>) -> Self {
        Self {
            entries: Arc::new(DashMap::new()),
            event_sender,
            watchers: Arc::new(DashMap::new()),
        }
    }

    pub fn register(
        &self,
        name: String,
        paths: Vec<String>,
        ignore_patterns: Vec<String>,
        debounce_ms: u32,
    ) -> Result<String, String> {
        let id = Uuid::new_v4().to_string();
        let sender = self.event_sender.clone();
        let watcher_id = id.clone();

        let debounce = Duration::from_millis(debounce_ms.max(100) as u64);

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Event>(256);

        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = tx.blocking_send(event);
                }
            },
            notify::Config::default().with_poll_interval(debounce),
        )
        .map_err(|e| format!("failed to create watcher: {e}"))?;

        for path in &paths {
            watcher
                .watch(&PathBuf::from(path), RecursiveMode::Recursive)
                .map_err(|e| format!("failed to watch {path}: {e}"))?;
        }

        let ignore = ignore_patterns.clone();
        let event_watcher_id = watcher_id.clone();

        tokio::spawn(async move {
            let mut last_event = tokio::time::Instant::now();

            while let Some(event) = rx.recv().await {
                let now = tokio::time::Instant::now();
                if now.duration_since(last_event) < debounce {
                    continue;
                }
                last_event = now;

                let paths_changed: Vec<String> = event
                    .paths
                    .iter()
                    .filter(|p| {
                        let path_str = p.to_string_lossy();
                        !ignore.iter().any(|pattern| path_str.contains(pattern))
                    })
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();

                if paths_changed.is_empty() {
                    continue;
                }

                let scheduler_event = SchedulerEvent {
                    id: Uuid::new_v4().to_string(),
                    trigger_type: TriggerType::FileChange.into(),
                    source: format!("watcher:{event_watcher_id}"),
                    payload: None,
                    timestamp: Some(prost_types::Timestamp {
                        seconds: chrono::Utc::now().timestamp(),
                        nanos: 0,
                    }),
                };

                if let Err(e) = sender.send(scheduler_event) {
                    error!(error = %e, "failed to send file change event");
                }
            }
        });

        self.entries.insert(
            id.clone(),
            WatcherEntry {
                id: id.clone(),
                name,
                paths,
                ignore_patterns,
                debounce_ms,
            },
        );

        self.watchers.insert(id.clone(), watcher);

        info!(watcher_id = %id, "registered file watcher");
        Ok(id)
    }

    pub fn unregister(&self, watcher_id: &str) -> bool {
        self.watchers.remove(watcher_id);
        self.entries.remove(watcher_id).is_some()
    }

    pub fn list(&self) -> Vec<crate::proto::agent::v1::WatcherEntry> {
        self.entries.iter().map(|entry| {
            crate::proto::agent::v1::WatcherEntry {
                watcher_id: entry.id.clone(),
                name: entry.name.clone(),
                paths: entry.paths.clone(),
                ignore_patterns: entry.ignore_patterns.clone(),
                debounce_ms: entry.debounce_ms,
            }
        }).collect()
    }
}
