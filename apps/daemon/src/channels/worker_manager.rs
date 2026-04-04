use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use tokio::sync::{Mutex, mpsc};
use tracing::{debug, error, info, warn};

#[derive(Debug)]
pub enum StreamEvent {
    Delta(String),
    Typing,
    Done(String),
    Error(String),
}

pub struct ChannelWorkerManager {
    worker_script_path: String,
    daemon_url: String,
    working_directory: String,
    child_process: Arc<Mutex<Option<Child>>>,
    worker_port: u16,
}

#[allow(dead_code)]
impl ChannelWorkerManager {
    pub fn new(
        worker_script_path: String,
        daemon_url: String,
        working_directory: String,
        worker_port: u16,
    ) -> Self {
        Self {
            worker_script_path,
            daemon_url,
            working_directory,
            child_process: Arc::new(Mutex::new(None)),
            worker_port,
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut child_guard = self.child_process.lock().await;

        if child_guard.is_some() {
            return Err("channel worker already running".to_string());
        }

        let child = Command::new("bun")
            .arg("run")
            .arg(&self.worker_script_path)
            .arg(format!("--port={}", self.worker_port))
            .arg(format!("--daemon-url={}", self.daemon_url))
            .current_dir(&self.working_directory)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("failed to spawn channel worker: {error}"))?;

        let pid = child.id();
        info!(pid = pid, port = self.worker_port, "channel worker spawned");

        *child_guard = Some(child);
        Ok(())
    }

    pub async fn is_running(&self) -> bool {
        let mut child_guard = self.child_process.lock().await;
        if let Some(child) = child_guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *child_guard = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            }
        } else {
            false
        }
    }

    pub async fn ensure_running(&self) -> Result<(), String> {
        if !self.is_running().await {
            warn!("channel worker not running, restarting");
            self.start().await?;
            self.wait_until_ready().await?;
        }
        Ok(())
    }

    async fn wait_until_ready(&self) -> Result<(), String> {
        let url = format!("{}/health", self.worker_url());
        let client = reqwest::Client::new();
        let max_attempts = 30;

        for attempt in 1..=max_attempts {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;

            match client
                .get(&url)
                .timeout(std::time::Duration::from_millis(1000))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    info!(attempt = attempt, "channel worker ready");
                    return Ok(());
                }
                _ => {
                    if attempt % 10 == 0 {
                        warn!(attempt = attempt, "still waiting for channel worker");
                    }
                }
            }
        }

        Err("channel worker failed to become ready after 6 seconds".to_string())
    }

    pub fn worker_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.worker_port)
    }

    pub async fn health_check(&self) -> bool {
        if !self.is_running().await {
            return false;
        }

        let url = format!("{}/health", self.worker_url());
        let client = reqwest::Client::new();

        match client
            .get(&url)
            .timeout(std::time::Duration::from_millis(5000))
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn send_message_stream(
        &self,
        session_id: &str,
        text: &str,
        channel_type: &str,
        chat_id: &str,
    ) -> Result<mpsc::Receiver<StreamEvent>, String> {
        let url = format!("{}/message", self.worker_url());
        let client = reqwest::Client::new();

        let body = serde_json::json!({
            "sessionId": session_id,
            "text": text,
            "channelType": channel_type,
            "chatId": chat_id,
        });

        let mut response = client
            .post(&url)
            .json(&body)
            .timeout(std::time::Duration::from_secs(600))
            .send()
            .await
            .map_err(|error| format!("failed to send message to channel worker: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown error".to_string());
            return Err(format!("channel worker returned {status}: {body_text}"));
        }

        let (tx, rx) = mpsc::channel(64);

        tokio::spawn(async move {
            let mut buffer = String::new();
            let mut event_count = 0u32;
            loop {
                match response.chunk().await {
                    Ok(Some(bytes)) => {
                        let chunk_str = String::from_utf8_lossy(&bytes);
                        debug!(chunk_len = bytes.len(), "SSE chunk received");
                        buffer.push_str(&chunk_str);
                        while let Some(pos) = buffer.find("\n\n") {
                            let event_line = buffer[..pos].to_string();
                            buffer = buffer[pos + 2..].to_string();

                            let data = match event_line.strip_prefix("data: ") {
                                Some(d) => d,
                                None => {
                                    debug!(line = %event_line, "SSE line without data prefix");
                                    continue;
                                }
                            };

                            let json: serde_json::Value = match serde_json::from_str(data) {
                                Ok(v) => v,
                                Err(parse_error) => {
                                    warn!(error = %parse_error, data = %data, "SSE JSON parse failed");
                                    continue;
                                }
                            };

                            let event_type = json["type"].as_str().unwrap_or("");
                            let text = json["text"].as_str().unwrap_or("").to_string();
                            event_count += 1;

                            let event = match event_type {
                                "delta" => StreamEvent::Delta(text),
                                "typing" => StreamEvent::Typing,
                                "done" => StreamEvent::Done(text),
                                "error" => StreamEvent::Error(text),
                                other => {
                                    debug!(event_type = %other, "unknown SSE event type");
                                    continue;
                                }
                            };

                            if tx.send(event).await.is_err() {
                                debug!("SSE receiver dropped");
                                return;
                            }
                        }
                    }
                    Ok(None) => {
                        debug!(event_count = event_count, "SSE stream ended");
                        break;
                    }
                    Err(err) => {
                        error!(error = %err, "SSE stream read error");
                        let _ = tx
                            .send(StreamEvent::Error(format!("stream error: {err}")))
                            .await;
                        break;
                    }
                }
            }
        });

        Ok(rx)
    }

    pub async fn shutdown(&self) {
        let mut child_guard = self.child_process.lock().await;
        if let Some(mut child) = child_guard.take() {
            let pid = child.id();
            info!(pid = pid, "shutting down channel worker");

            if let Err(kill_error) = child.kill() {
                warn!(
                    pid = pid,
                    error = %kill_error,
                    "failed to kill channel worker (may have already exited)"
                );
            }
        }
    }
}
