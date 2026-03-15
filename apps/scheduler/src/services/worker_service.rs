use std::sync::Arc;

use tokio::sync::broadcast;
use tonic::{Request, Response, Status};
use tracing::{error, info, warn};

use crate::db::tasks::TaskStore;
use crate::orchestrator::heartbeat::HeartbeatTracker;
#[cfg(test)]
use crate::proto::agent::v1::{ToolFunction, ToolParameter};
use crate::proto::agent::v1::{
    worker_service_server::WorkerService,
    CompleteRequest, CompleteResponse,
    StreamCompleteRequest, StreamCompleteResponse,
    GetTaskRequest, GetTaskResponse,
    ReportProgressRequest, ReportProgressResponse,
    WriteLogRequest, WriteLogResponse,
    ReportResultRequest, ReportResultResponse,
    HeartbeatRequest, HeartbeatResponse,
    ChatMessage, ToolCallEntry, ToolCallFunction,
    Tool,
};

/// An event broadcast when a worker reports activity on a task.
/// Used by the DaemonService's WatchTasks stream to push live updates
/// to CLI/TUI subscribers.
#[derive(Debug, Clone)]
pub struct WorkerActivityEvent {
    pub task_id: String,
    pub activity: String,
}

/// Implements the WorkerService gRPC trait generated from worker.proto.
///
/// This is the service that agent worker subprocesses (TypeScript/Bun) call to:
/// - Fetch their assigned task details (`get_task`)
/// - Proxy LLM completion requests through the Go gateway (`complete`)
/// - Report progress, write logs, report final results, and send heartbeats
///
/// Workers have no API keys — all LLM access is proxied through this service,
/// which forwards requests to the Go gateway (still running as a child process
/// in Phase 1) and returns responses to workers.
pub struct WorkerServiceImplementation {
    task_store: Arc<TaskStore>,
    heartbeat_tracker: Arc<HeartbeatTracker>,
    gateway_base_url: String,
    activity_event_sender: broadcast::Sender<WorkerActivityEvent>,
    http_client: reqwest::Client,
}

impl WorkerServiceImplementation {
    /// Creates a new WorkerServiceImplementation.
    ///
    /// - `task_store`: shared access to the SQLite-backed task table.
    /// - `heartbeat_tracker`: shared heartbeat tracker for recording worker liveness.
    /// - `gateway_base_url`: base URL of the Go gateway for proxying LLM calls
    ///   (e.g. "http://localhost:50052").
    /// - `activity_event_sender`: broadcast channel for worker activity events.
    pub fn new(
        task_store: Arc<TaskStore>,
        heartbeat_tracker: Arc<HeartbeatTracker>,
        gateway_base_url: String,
        activity_event_sender: broadcast::Sender<WorkerActivityEvent>,
    ) -> Self {
        Self {
            task_store,
            heartbeat_tracker,
            gateway_base_url,
            activity_event_sender,
            http_client: reqwest::Client::new(),
        }
    }

    /// Returns a clone of the activity event sender so other services
    /// (e.g. DaemonService) can subscribe to worker activity broadcasts.
    pub fn get_activity_event_sender(&self) -> broadcast::Sender<WorkerActivityEvent> {
        self.activity_event_sender.clone()
    }
}

// ---------------------------------------------------------------------------
// JSON serialization helpers for proxying to the Go gateway
//
// These are temporary Phase 1 bridges that convert between proto types and
// the JSON format expected by ConnectRPC. They will be replaced when the Go
// gateway is migrated to Rust in Phase 1b.
// ---------------------------------------------------------------------------

/// Serializes a CompleteRequest proto into the JSON body the Go gateway expects.
fn serialize_complete_request_to_json(
    request: &CompleteRequest,
) -> Result<serde_json::Value, String> {
    let messages: Vec<serde_json::Value> = request
        .messages
        .iter()
        .map(serialize_chat_message_to_json)
        .collect();

    let tools: Vec<serde_json::Value> = request
        .tools
        .iter()
        .map(serialize_tool_to_json)
        .collect();

    let mut json_body = serde_json::json!({
        "model": request.model,
        "messages": messages,
    });

    if let Some(temperature) = request.temperature {
        json_body["temperature"] = serde_json::json!(temperature);
    }

    if let Some(max_tokens) = request.max_tokens {
        json_body["maxTokens"] = serde_json::json!(max_tokens);
    }

    if let Some(ref system_prompt) = request.system_prompt {
        json_body["systemPrompt"] = serde_json::json!(system_prompt);
    }

    if !tools.is_empty() {
        json_body["tools"] = serde_json::json!(tools);
    }

    if let Some(ref provider) = request.provider {
        json_body["provider"] = serde_json::json!(provider);
    }

    Ok(json_body)
}

/// Serializes a single ChatMessage proto to JSON.
fn serialize_chat_message_to_json(message: &ChatMessage) -> serde_json::Value {
    let mut json_message = serde_json::json!({
        "role": message.role,
        "content": message.content,
    });

    if !message.tool_calls.is_empty() {
        let tool_calls: Vec<serde_json::Value> = message
            .tool_calls
            .iter()
            .map(serialize_tool_call_entry_to_json)
            .collect();
        json_message["toolCalls"] = serde_json::json!(tool_calls);
    }

    if !message.tool_call_id.is_empty() {
        json_message["toolCallId"] = serde_json::json!(message.tool_call_id);
    }

    if let Some(ref name) = message.name {
        json_message["name"] = serde_json::json!(name);
    }

    json_message
}

/// Serializes a ToolCallEntry proto to JSON.
fn serialize_tool_call_entry_to_json(tool_call: &ToolCallEntry) -> serde_json::Value {
    let mut json_tool_call = serde_json::json!({
        "id": tool_call.id,
        "type": tool_call.r#type,
    });

    if let Some(ref function) = tool_call.function {
        json_tool_call["function"] = serde_json::json!({
            "name": function.name,
            "arguments": function.arguments,
        });
    }

    json_tool_call
}

/// Serializes a Tool proto to JSON.
fn serialize_tool_to_json(tool: &Tool) -> serde_json::Value {
    let mut json_tool = serde_json::json!({
        "type": tool.r#type,
    });

    if let Some(ref function) = tool.function {
        let mut json_function = serde_json::json!({
            "name": function.name,
            "description": function.description,
        });

        if let Some(ref parameters) = function.parameters {
            json_function["parameters"] = serde_json::json!({
                "type": parameters.r#type,
                "propertiesJson": parameters.properties_json,
                "required": parameters.required,
            });
        }

        json_tool["function"] = json_function;
    }

    json_tool
}

/// Deserializes a ConnectRPC JSON response from the Go gateway into a
/// CompleteResponse proto.
fn deserialize_complete_response_from_json(
    json_value: &serde_json::Value,
) -> Result<CompleteResponse, String> {
    let id = json_value
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let model = json_value
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let message = json_value
        .get("message")
        .map(deserialize_chat_message_from_json);

    let prompt_tokens = json_value
        .get("promptTokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    let completion_tokens = json_value
        .get("completionTokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    let tool_calls = json_value
        .get("toolCalls")
        .and_then(|v| v.as_array())
        .map(|array| {
            array
                .iter()
                .map(deserialize_tool_call_entry_from_json)
                .collect()
        })
        .unwrap_or_default();

    let finish_reason = json_value
        .get("finishReason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(CompleteResponse {
        id,
        model,
        message,
        prompt_tokens,
        completion_tokens,
        tool_calls,
        finish_reason,
    })
}

/// Deserializes a ChatMessage from a JSON value.
fn deserialize_chat_message_from_json(json_value: &serde_json::Value) -> ChatMessage {
    let role = json_value
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let content = json_value
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let tool_calls = json_value
        .get("toolCalls")
        .and_then(|v| v.as_array())
        .map(|array| {
            array
                .iter()
                .map(deserialize_tool_call_entry_from_json)
                .collect()
        })
        .unwrap_or_default();

    let tool_call_id = json_value
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let name = json_value
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    ChatMessage {
        role,
        content,
        tool_calls,
        tool_call_id,
        name,
    }
}

/// Deserializes a ToolCallEntry from a JSON value.
fn deserialize_tool_call_entry_from_json(json_value: &serde_json::Value) -> ToolCallEntry {
    let id = json_value
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let entry_type = json_value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let function = json_value.get("function").map(|function_json| {
        ToolCallFunction {
            name: function_json
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            arguments: function_json
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        }
    });

    ToolCallEntry {
        id,
        r#type: entry_type,
        function,
    }
}

// ---------------------------------------------------------------------------
// gRPC trait implementation
// ---------------------------------------------------------------------------

#[tonic::async_trait]
impl WorkerService for WorkerServiceImplementation {
    /// Fetches task details from the task store by ID.
    /// Returns NotFound if no task exists with the given ID.
    async fn get_task(
        &self,
        request: Request<GetTaskRequest>,
    ) -> Result<Response<GetTaskResponse>, Status> {
        let get_task_request = request.into_inner();
        let task_id = &get_task_request.task_id;

        info!(task_id = %task_id, "worker requesting task details");

        let task = self
            .task_store
            .get_task(task_id)
            .await
            .ok_or_else(|| Status::not_found(format!("task not found: {task_id}")))?;

        Ok(Response::new(GetTaskResponse {
            task_id: task.id,
            name: task.name,
            description: task.description,
            working_dir: task.worker_dir.unwrap_or_default(),
            retry_context: String::new(),
            attempt: task.attempt,
        }))
    }

    /// Proxies LLM completion requests to the Go gateway.
    ///
    /// The worker sends a CompleteRequest via gRPC. This method:
    /// 1. Extracts the `x-task-id` metadata (before consuming the request)
    /// 2. Serializes the request to JSON in ConnectRPC format
    /// 3. POSTs to the Go gateway's Complete endpoint
    /// 4. Parses the JSON response back into a CompleteResponse proto
    /// 5. Tracks token usage if a task ID was provided
    async fn complete(
        &self,
        request: Request<CompleteRequest>,
    ) -> Result<Response<CompleteResponse>, Status> {
        // CRITICAL: Extract metadata BEFORE calling into_inner(), which consumes the Request
        let task_id_from_metadata = request
            .metadata()
            .get("x-task-id")
            .and_then(|value| value.to_str().ok())
            .map(|s| s.to_string());

        let complete_request = request.into_inner();

        let json_body = serialize_complete_request_to_json(&complete_request)
            .map_err(|error| Status::internal(format!("failed to serialize request: {error}")))?;

        let gateway_url = format!(
            "{}/agent.v1.GatewayService/Complete",
            self.gateway_base_url
        );

        let http_response = self
            .http_client
            .post(&gateway_url)
            .header("Content-Type", "application/json")
            .json(&json_body)
            .send()
            .await
            .map_err(|error| {
                error!(
                    gateway_url = %gateway_url,
                    error = %error,
                    "failed to send request to gateway"
                );
                Status::unavailable(format!("gateway unreachable: {error}"))
            })?;

        if !http_response.status().is_success() {
            let status_code = http_response.status();
            let error_body = http_response.text().await.unwrap_or_default();
            error!(
                status_code = %status_code,
                error_body = %error_body,
                "gateway returned error"
            );
            return Err(Status::internal(format!(
                "gateway error (HTTP {status_code}): {error_body}"
            )));
        }

        let response_json: serde_json::Value = http_response.json().await.map_err(|error| {
            error!(error = %error, "failed to parse gateway response JSON");
            Status::internal(format!("failed to parse gateway response: {error}"))
        })?;

        let complete_response =
            deserialize_complete_response_from_json(&response_json).map_err(|error| {
                error!(error = %error, "failed to deserialize gateway response");
                Status::internal(format!(
                    "failed to deserialize gateway response: {error}"
                ))
            })?;

        // Track token usage if we have a task ID from metadata
        if let Some(ref task_id) = task_id_from_metadata {
            let prompt_tokens = complete_response.prompt_tokens as i64;
            let completion_tokens = complete_response.completion_tokens as i64;

            if let Err(token_error) = self
                .task_store
                .add_token_usage(task_id, prompt_tokens, completion_tokens, 0.0)
                .await
            {
                warn!(
                    task_id = %task_id,
                    error = %token_error,
                    "failed to track token usage"
                );
            }
        }

        Ok(Response::new(complete_response))
    }

    type StreamCompleteStream = std::pin::Pin<
        Box<dyn tokio_stream::Stream<Item = Result<StreamCompleteResponse, Status>> + Send>,
    >;

    /// Streaming completions are not yet implemented — will be added in Phase 1b
    /// when the Go gateway is migrated to Rust.
    async fn stream_complete(
        &self,
        _request: Request<StreamCompleteRequest>,
    ) -> Result<Response<Self::StreamCompleteStream>, Status> {
        Err(Status::unimplemented(
            "streaming will be implemented in Phase 1b",
        ))
    }

    /// Records a progress report from a worker and broadcasts it as an
    /// activity event. The activity string is written to the task log
    /// so it persists across daemon restarts.
    async fn report_progress(
        &self,
        request: Request<ReportProgressRequest>,
    ) -> Result<Response<ReportProgressResponse>, Status> {
        let progress_request = request.into_inner();
        let task_id = &progress_request.task_id;
        let activity = &progress_request.activity;

        info!(
            task_id = %task_id,
            activity = %activity,
            progress_pct = progress_request.progress_pct,
            "worker reported progress"
        );

        // Write the progress activity as a log entry
        if let Err(log_error) = self
            .task_store
            .write_log(task_id, "info", &format!("[progress] {activity}"))
            .await
        {
            warn!(
                task_id = %task_id,
                error = %log_error,
                "failed to write progress log"
            );
        }

        // Broadcast the activity event for live TUI/CLI subscribers
        let _ = self.activity_event_sender.send(WorkerActivityEvent {
            task_id: task_id.clone(),
            activity: activity.clone(),
        });

        Ok(Response::new(ReportProgressResponse {}))
    }

    /// Writes a log entry for a task. Workers use this to persist structured
    /// logs (info, warn, error) that can be viewed via the CLI or TUI.
    async fn write_log(
        &self,
        request: Request<WriteLogRequest>,
    ) -> Result<Response<WriteLogResponse>, Status> {
        let log_request = request.into_inner();
        let task_id = &log_request.task_id;
        let level = &log_request.level;
        let message = &log_request.message;

        if let Err(log_error) = self
            .task_store
            .write_log(task_id, level, message)
            .await
        {
            warn!(
                task_id = %task_id,
                error = %log_error,
                "failed to write task log"
            );
            return Err(Status::internal(format!(
                "failed to write log: {log_error}"
            )));
        }

        Ok(Response::new(WriteLogResponse {}))
    }

    /// Reports the final result of a task execution. Updates the task's
    /// exit code, output, error message, and status (completed if exit_code
    /// is 0, failed otherwise). Artifacts are serialized to JSON for storage.
    async fn report_result(
        &self,
        request: Request<ReportResultRequest>,
    ) -> Result<Response<ReportResultResponse>, Status> {
        let result_request = request.into_inner();
        let task_id = &result_request.task_id;
        let exit_code = result_request.exit_code;

        let final_status = if exit_code == 0 {
            "completed"
        } else {
            "failed"
        };

        info!(
            task_id = %task_id,
            exit_code = exit_code,
            status = final_status,
            "worker reported result"
        );

        // Serialize artifacts to JSON if present
        let artifacts_json = if result_request.artifacts.is_empty() {
            None
        } else {
            let artifacts_data: Vec<serde_json::Value> = result_request
                .artifacts
                .iter()
                .map(|artifact| {
                    serde_json::json!({
                        "type": artifact.r#type,
                        "url": artifact.url,
                        "name": artifact.name,
                    })
                })
                .collect();
            Some(
                serde_json::to_string(&artifacts_data)
                    .unwrap_or_else(|_| "[]".to_string()),
            )
        };

        let output = if result_request.output.is_empty() {
            None
        } else {
            Some(result_request.output.as_str())
        };

        let error_message = if result_request.error_message.is_empty() {
            None
        } else {
            Some(result_request.error_message.as_str())
        };

        // Update the task result in the store
        if let Err(result_error) = self
            .task_store
            .update_result(
                task_id,
                exit_code,
                output,
                error_message,
                artifacts_json.as_deref(),
            )
            .await
        {
            error!(
                task_id = %task_id,
                error = %result_error,
                "failed to update task result"
            );
            return Err(Status::internal(format!(
                "failed to update task result: {result_error}"
            )));
        }

        // Update the task status
        if let Err(status_error) = self
            .task_store
            .update_status(task_id, final_status)
            .await
        {
            error!(
                task_id = %task_id,
                error = %status_error,
                "failed to update task status"
            );
            return Err(Status::internal(format!(
                "failed to update task status: {status_error}"
            )));
        }

        Ok(Response::new(ReportResultResponse {}))
    }

    /// Records a heartbeat from a worker, indicating it is still alive and
    /// processing. The orchestrator uses heartbeat data to detect and kill
    /// stale workers that have stopped responding.
    async fn heartbeat(
        &self,
        request: Request<HeartbeatRequest>,
    ) -> Result<Response<HeartbeatResponse>, Status> {
        let heartbeat_request = request.into_inner();
        let task_id = &heartbeat_request.task_id;

        self.heartbeat_tracker.record_heartbeat(task_id);

        Ok(Response::new(HeartbeatResponse {}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // JSON serialization round-trip tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_serialize_complete_request_minimal() {
        let request = CompleteRequest {
            model: "gpt-4".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: None,
            }],
            temperature: None,
            max_tokens: None,
            system_prompt: None,
            tools: vec![],
            provider: None,
        };

        let json_result = serialize_complete_request_to_json(&request);
        assert!(json_result.is_ok());

        let json_value = json_result.unwrap();
        assert_eq!(json_value["model"], "gpt-4");
        assert_eq!(json_value["messages"][0]["role"], "user");
        assert_eq!(json_value["messages"][0]["content"], "Hello");
        assert!(json_value.get("temperature").is_none());
        assert!(json_value.get("tools").is_none());
    }

    #[test]
    fn test_serialize_complete_request_with_all_fields() {
        let request = CompleteRequest {
            model: "claude-3-opus".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "Explain Rust".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: None,
            }],
            temperature: Some(0.7),
            max_tokens: Some(4096),
            system_prompt: Some("You are a helpful assistant.".to_string()),
            tools: vec![Tool {
                r#type: "function".to_string(),
                function: Some(ToolFunction {
                    name: "read_file".to_string(),
                    description: "Reads a file from disk".to_string(),
                    parameters: Some(ToolParameter {
                        r#type: "object".to_string(),
                        properties_json: r#"{"path":{"type":"string"}}"#.to_string(),
                        required: vec!["path".to_string()],
                    }),
                }),
            }],
            provider: Some("anthropic".to_string()),
        };

        let json_result = serialize_complete_request_to_json(&request);
        assert!(json_result.is_ok());

        let json_value = json_result.unwrap();
        assert_eq!(json_value["model"], "claude-3-opus");
        // Proto temperature is f32, so 0.7 loses precision when serialized to JSON.
        // Compare as f64 with tolerance instead of exact equality.
        let temperature = json_value["temperature"].as_f64().unwrap();
        assert!((temperature - 0.7).abs() < 0.001, "temperature was {temperature}");
        assert_eq!(json_value["maxTokens"], 4096);
        assert_eq!(json_value["systemPrompt"], "You are a helpful assistant.");
        assert_eq!(json_value["provider"], "anthropic");
        assert_eq!(json_value["tools"][0]["type"], "function");
        assert_eq!(json_value["tools"][0]["function"]["name"], "read_file");
        assert_eq!(
            json_value["tools"][0]["function"]["parameters"]["required"][0],
            "path"
        );
    }

    #[test]
    fn test_serialize_chat_message_with_tool_calls() {
        let message = ChatMessage {
            role: "assistant".to_string(),
            content: String::new(),
            tool_calls: vec![ToolCallEntry {
                id: "call_123".to_string(),
                r#type: "function".to_string(),
                function: Some(ToolCallFunction {
                    name: "read_file".to_string(),
                    arguments: r#"{"path":"src/main.rs"}"#.to_string(),
                }),
            }],
            tool_call_id: String::new(),
            name: None,
        };

        let json_value = serialize_chat_message_to_json(&message);
        assert_eq!(json_value["role"], "assistant");
        assert_eq!(json_value["toolCalls"][0]["id"], "call_123");
        assert_eq!(json_value["toolCalls"][0]["type"], "function");
        assert_eq!(json_value["toolCalls"][0]["function"]["name"], "read_file");
    }

    #[test]
    fn test_serialize_chat_message_with_tool_result() {
        let message = ChatMessage {
            role: "tool".to_string(),
            content: "file contents here".to_string(),
            tool_calls: vec![],
            tool_call_id: "call_123".to_string(),
            name: Some("read_file".to_string()),
        };

        let json_value = serialize_chat_message_to_json(&message);
        assert_eq!(json_value["role"], "tool");
        assert_eq!(json_value["content"], "file contents here");
        assert_eq!(json_value["toolCallId"], "call_123");
        assert_eq!(json_value["name"], "read_file");
    }

    #[test]
    fn test_deserialize_complete_response() {
        let json_value = serde_json::json!({
            "id": "resp-001",
            "model": "gpt-4",
            "message": {
                "role": "assistant",
                "content": "Hello there!",
            },
            "promptTokens": 10,
            "completionTokens": 5,
            "finishReason": "stop",
        });

        let response = deserialize_complete_response_from_json(&json_value);
        assert!(response.is_ok());

        let complete_response = response.unwrap();
        assert_eq!(complete_response.id, "resp-001");
        assert_eq!(complete_response.model, "gpt-4");
        assert_eq!(complete_response.prompt_tokens, 10);
        assert_eq!(complete_response.completion_tokens, 5);
        assert_eq!(complete_response.finish_reason, "stop");

        let message = complete_response.message.unwrap();
        assert_eq!(message.role, "assistant");
        assert_eq!(message.content, "Hello there!");
    }

    #[test]
    fn test_deserialize_complete_response_with_tool_calls() {
        let json_value = serde_json::json!({
            "id": "resp-002",
            "model": "gpt-4",
            "message": {
                "role": "assistant",
                "content": "",
                "toolCalls": [
                    {
                        "id": "call_abc",
                        "type": "function",
                        "function": {
                            "name": "write_file",
                            "arguments": "{\"path\":\"test.txt\",\"content\":\"hello\"}"
                        }
                    }
                ]
            },
            "promptTokens": 20,
            "completionTokens": 15,
            "toolCalls": [
                {
                    "id": "call_abc",
                    "type": "function",
                    "function": {
                        "name": "write_file",
                        "arguments": "{\"path\":\"test.txt\",\"content\":\"hello\"}"
                    }
                }
            ],
            "finishReason": "tool_calls",
        });

        let response = deserialize_complete_response_from_json(&json_value);
        assert!(response.is_ok());

        let complete_response = response.unwrap();

        // Check top-level tool_calls
        assert_eq!(complete_response.tool_calls.len(), 1);
        assert_eq!(complete_response.tool_calls[0].id, "call_abc");
        let function = complete_response.tool_calls[0].function.as_ref().unwrap();
        assert_eq!(function.name, "write_file");

        // Check message-level tool_calls
        let message = complete_response.message.unwrap();
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].id, "call_abc");
    }

    #[test]
    fn test_deserialize_complete_response_minimal() {
        let json_value = serde_json::json!({});

        let response = deserialize_complete_response_from_json(&json_value);
        assert!(response.is_ok());

        let complete_response = response.unwrap();
        assert_eq!(complete_response.id, "");
        assert_eq!(complete_response.model, "");
        assert!(complete_response.message.is_none());
        assert_eq!(complete_response.prompt_tokens, 0);
        assert_eq!(complete_response.completion_tokens, 0);
        assert!(complete_response.tool_calls.is_empty());
    }

    #[test]
    fn test_worker_activity_event_clone() {
        let event = WorkerActivityEvent {
            task_id: "task-123".to_string(),
            activity: "reading files".to_string(),
        };
        let cloned_event = event.clone();
        assert_eq!(cloned_event.task_id, "task-123");
        assert_eq!(cloned_event.activity, "reading files");
    }

    #[test]
    fn test_serialize_tool_with_nested_function() {
        let tool = Tool {
            r#type: "function".to_string(),
            function: Some(ToolFunction {
                name: "search".to_string(),
                description: "Search the web".to_string(),
                parameters: Some(ToolParameter {
                    r#type: "object".to_string(),
                    properties_json: r#"{"query":{"type":"string"}}"#.to_string(),
                    required: vec!["query".to_string()],
                }),
            }),
        };

        let json_value = serialize_tool_to_json(&tool);
        assert_eq!(json_value["type"], "function");
        assert_eq!(json_value["function"]["name"], "search");
        assert_eq!(json_value["function"]["description"], "Search the web");
        assert_eq!(
            json_value["function"]["parameters"]["type"],
            "object"
        );
    }

    #[test]
    fn test_serialize_tool_without_function() {
        let tool = Tool {
            r#type: "function".to_string(),
            function: None,
        };

        let json_value = serialize_tool_to_json(&tool);
        assert_eq!(json_value["type"], "function");
        assert!(json_value.get("function").is_none());
    }
}
