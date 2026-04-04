use std::collections::VecDeque;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use dashmap::DashMap;

#[derive(Debug, Clone)]
pub enum RateLimitResult {
    Allowed,
    Exceeded {
        #[allow(dead_code)]
        retry_after_seconds: u64,
    },
}

impl RateLimitResult {
    pub fn is_exceeded(&self) -> bool {
        matches!(self, Self::Exceeded { .. })
    }
}

struct SlidingWindow {
    timestamps: VecDeque<Instant>,
    max_events: usize,
    window_duration: Duration,
}

impl SlidingWindow {
    fn new(max_events: usize, window_duration: Duration) -> Self {
        Self {
            timestamps: VecDeque::new(),
            max_events,
            window_duration,
        }
    }

    fn check_and_record(&mut self) -> RateLimitResult {
        let now = Instant::now();
        let cutoff = now - self.window_duration;

        while self.timestamps.front().is_some_and(|t| *t < cutoff) {
            self.timestamps.pop_front();
        }

        if self.timestamps.len() >= self.max_events {
            let oldest_in_window = self.timestamps.front().copied().unwrap_or(now);
            let retry_after = self
                .window_duration
                .checked_sub(now.duration_since(oldest_in_window))
                .unwrap_or(Duration::from_secs(1));
            return RateLimitResult::Exceeded {
                retry_after_seconds: retry_after.as_secs().max(1),
            };
        }

        self.timestamps.push_back(now);
        RateLimitResult::Allowed
    }
}

pub struct RateLimiter {
    windows: DashMap<String, SlidingWindow>,
    default_max_events: usize,
    default_window_duration: Duration,
}

impl RateLimiter {
    pub fn new(max_events: usize, window_minutes: u64) -> Self {
        Self {
            windows: DashMap::new(),
            default_max_events: max_events,
            default_window_duration: Duration::from_secs(window_minutes * 60),
        }
    }

    pub fn check(&self, key: &str) -> RateLimitResult {
        let mut window = self.windows.entry(key.to_string()).or_insert_with(|| {
            SlidingWindow::new(self.default_max_events, self.default_window_duration)
        });
        window.check_and_record()
    }
}

struct LoopEntry {
    prompt_hash: u64,
    timestamp: Instant,
}

pub struct LoopDetector {
    entries: std::sync::Mutex<VecDeque<LoopEntry>>,
    window_duration: Duration,
    max_similar_tasks: usize,
}

impl LoopDetector {
    pub fn new(window_minutes: u64, max_similar_tasks: usize) -> Self {
        Self {
            entries: std::sync::Mutex::new(VecDeque::new()),
            window_duration: Duration::from_secs(window_minutes * 60),
            max_similar_tasks,
        }
    }

    pub fn check_loop(&self, prompt: &str) -> bool {
        let mut hasher = DefaultHasher::new();
        prompt.hash(&mut hasher);
        let prompt_hash = hasher.finish();

        let now = Instant::now();
        let cutoff = now - self.window_duration;

        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        while entries.front().is_some_and(|e| e.timestamp < cutoff) {
            entries.pop_front();
        }

        let matching_count = entries
            .iter()
            .filter(|e| e.prompt_hash == prompt_hash)
            .count();

        entries.push_back(LoopEntry {
            prompt_hash,
            timestamp: now,
        });

        matching_count >= self.max_similar_tasks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_limiter_allows_within_limit() {
        let limiter = RateLimiter::new(3, 1);
        assert!(!limiter.check("key1").is_exceeded());
        assert!(!limiter.check("key1").is_exceeded());
        assert!(!limiter.check("key1").is_exceeded());
    }

    #[test]
    fn test_rate_limiter_exceeds_limit() {
        let limiter = RateLimiter::new(2, 1);
        assert!(!limiter.check("key1").is_exceeded());
        assert!(!limiter.check("key1").is_exceeded());
        assert!(limiter.check("key1").is_exceeded());
    }

    #[test]
    fn test_rate_limiter_separate_keys() {
        let limiter = RateLimiter::new(1, 1);
        assert!(!limiter.check("key1").is_exceeded());
        assert!(!limiter.check("key2").is_exceeded());
        assert!(limiter.check("key1").is_exceeded());
    }

    #[test]
    fn test_loop_detector_no_loop() {
        let detector = LoopDetector::new(10, 3);
        assert!(!detector.check_loop("prompt A"));
        assert!(!detector.check_loop("prompt B"));
        assert!(!detector.check_loop("prompt C"));
    }

    #[test]
    fn test_loop_detector_detects_loop() {
        let detector = LoopDetector::new(10, 3);
        assert!(!detector.check_loop("same prompt"));
        assert!(!detector.check_loop("same prompt"));
        assert!(!detector.check_loop("same prompt"));
        assert!(detector.check_loop("same prompt"));
    }

    #[test]
    fn test_loop_detector_different_prompts_no_loop() {
        let detector = LoopDetector::new(10, 3);
        for i in 0..10 {
            assert!(!detector.check_loop(&format!("unique prompt {i}")));
        }
    }
}
