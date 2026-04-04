use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub enum TriggerType {
    Cron,
    FileChange,
}

#[derive(Debug, Clone)]
pub struct SchedulerEvent {
    pub id: String,
    pub trigger_type: TriggerType,
    pub source: String,
    pub payload: Option<serde_json::Value>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronEntry {
    pub cron_id: String,
    pub name: String,
    pub cron_expression: String,
    pub task_template: String,
    pub next_run: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherEntry {
    pub watcher_id: String,
    pub name: String,
    pub paths: Vec<String>,
    pub ignore_patterns: Vec<String>,
    pub debounce_ms: u32,
}
