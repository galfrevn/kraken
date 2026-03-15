use std::time::{Duration, Instant};

use dashmap::DashMap;

/// Tracks the last heartbeat time for each active worker, keyed by task ID.
/// Workers send periodic heartbeats to indicate they are still alive. If a
/// worker's last heartbeat exceeds the configured timeout, the orchestrator
/// considers it stale and kills it.
pub struct HeartbeatTracker {
    last_heartbeat_times: DashMap<String, Instant>,
    timeout_duration: Duration,
}

impl HeartbeatTracker {
    /// Creates a new heartbeat tracker with the given timeout in seconds.
    /// Workers that do not send a heartbeat within this duration are
    /// considered stale and eligible for termination.
    pub fn new(timeout_seconds: u64) -> Self {
        Self {
            last_heartbeat_times: DashMap::new(),
            timeout_duration: Duration::from_secs(timeout_seconds),
        }
    }

    /// Records a heartbeat for the given task, updating its last-seen time
    /// to the current instant. If the task is not yet tracked, a new entry
    /// is created.
    pub fn record_heartbeat(&self, task_id: &str) {
        self.last_heartbeat_times
            .insert(task_id.to_string(), Instant::now());
    }

    /// Returns `true` if the worker for the given task has sent a heartbeat
    /// within the configured timeout window. Returns `false` if the task
    /// has no recorded heartbeat or the last heartbeat is older than the
    /// timeout duration.
    #[allow(dead_code)]
    pub fn is_worker_alive(&self, task_id: &str) -> bool {
        match self.last_heartbeat_times.get(task_id) {
            Some(last_heartbeat_time) => last_heartbeat_time.elapsed() < self.timeout_duration,
            None => false,
        }
    }

    /// Removes the heartbeat tracking entry for the given task. Called when
    /// a worker exits (normally or via kill) so the tracker does not
    /// accumulate stale entries.
    pub fn remove_tracking(&self, task_id: &str) {
        self.last_heartbeat_times.remove(task_id);
    }

    /// Returns a list of all task IDs whose last heartbeat has exceeded
    /// the timeout duration. These workers are considered stale and should
    /// be terminated by the orchestrator.
    pub fn get_stale_task_ids(&self) -> Vec<String> {
        self.last_heartbeat_times
            .iter()
            .filter(|entry| entry.value().elapsed() >= self.timeout_duration)
            .map(|entry| entry.key().clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_new_tracker_has_no_entries() {
        let heartbeat_tracker = HeartbeatTracker::new(300);
        assert!(!heartbeat_tracker.is_worker_alive("nonexistent-task"));
        assert!(heartbeat_tracker.get_stale_task_ids().is_empty());
    }

    #[test]
    fn test_record_heartbeat_makes_worker_alive() {
        let heartbeat_tracker = HeartbeatTracker::new(300);
        heartbeat_tracker.record_heartbeat("task-1");
        assert!(heartbeat_tracker.is_worker_alive("task-1"));
    }

    #[test]
    fn test_stale_heartbeat_detected() {
        // Use a very short timeout so the test completes quickly
        let heartbeat_tracker = HeartbeatTracker::new(0);
        heartbeat_tracker.record_heartbeat("task-stale");

        // Sleep just enough to exceed the zero-second timeout
        thread::sleep(Duration::from_millis(10));

        assert!(!heartbeat_tracker.is_worker_alive("task-stale"));

        let stale_task_ids = heartbeat_tracker.get_stale_task_ids();
        assert_eq!(stale_task_ids.len(), 1);
        assert_eq!(stale_task_ids[0], "task-stale");
    }

    #[test]
    fn test_remove_tracking_clears_entry() {
        let heartbeat_tracker = HeartbeatTracker::new(300);
        heartbeat_tracker.record_heartbeat("task-remove");
        assert!(heartbeat_tracker.is_worker_alive("task-remove"));

        heartbeat_tracker.remove_tracking("task-remove");
        assert!(!heartbeat_tracker.is_worker_alive("task-remove"));
    }

    #[test]
    fn test_remove_tracking_nonexistent_does_not_panic() {
        let heartbeat_tracker = HeartbeatTracker::new(300);
        heartbeat_tracker.remove_tracking("does-not-exist");
    }

    #[test]
    fn test_multiple_heartbeats_refreshes_time() {
        let heartbeat_tracker = HeartbeatTracker::new(1);
        heartbeat_tracker.record_heartbeat("task-refresh");

        // Sleep partway through the timeout
        thread::sleep(Duration::from_millis(500));

        // Re-record — should reset the clock
        heartbeat_tracker.record_heartbeat("task-refresh");
        assert!(heartbeat_tracker.is_worker_alive("task-refresh"));
    }

    #[test]
    fn test_get_stale_task_ids_excludes_alive_workers() {
        let heartbeat_tracker = HeartbeatTracker::new(60);

        heartbeat_tracker.record_heartbeat("alive-task");

        let stale_task_ids = heartbeat_tracker.get_stale_task_ids();
        assert!(stale_task_ids.is_empty());
    }
}
