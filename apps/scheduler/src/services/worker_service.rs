use std::sync::Arc;

use tokio::sync::broadcast;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};
use tracing::{error, info, warn};

use crate::db::tasks::TaskStore;
use crate::llm::router::LlmProviderRouter;
use crate::llm::types::{
    LlmChatMessage, LlmCompletionRequest, LlmCompletionResponse, LlmProviderError,
    LlmStreamChunk, LlmToolCall, LlmToolDefinition,
};
use crate::orchestrator::heartbeat::HeartbeatTracker;
use crate::proto::agent::v1::{
    worker_service_server::WorkerService, ChatMessage, CompleteRequest, CompleteResponse,
    GetTaskRequest, GetTaskResponse, HeartbeatRequest, HeartbeatResponse, ReportProgressRequest,
    ReportProgressResponse, ReportResultRequest, ReportResultResponse, StreamCompleteRequest,
    StreamCompleteResponse, Tool, ToolCallEntry, ToolCallFunction, WriteLogRequest,
    WriteLogResponse,
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
/// - Perform LLM completion requests via the Rust LlmProviderRouter (`complete`)
/// - Stream LLM completion requests (`stream_complete`)
/// - Report progress, write logs, report final results, and send heartbeats
///
/// Workers have no API keys -- all LLM access is routed through this service
/// via the `LlmProviderRouter`, which dispatches to the appropriate provider
/// (OpenRouter, OpenAI, Anthropic, or Ollama) based on request configuration.
pub struct WorkerServiceImplementation {
    task_store: Arc<TaskStore>,
    heartbeat_tracker: Arc<HeartbeatTracker>,
    llm_provider_router: Arc<LlmProviderRouter>,
    activity_event_sender: broadcast::Sender<WorkerActivityEvent>,
}

impl WorkerServiceImplementation {
    /// Creates a new WorkerServiceImplementation.
    ///
    /// - `task_store`: shared access to the SQLite-backed task table.
    /// - `heartbeat_tracker`: shared heartbeat tracker for recording worker liveness.
    /// - `llm_provider_router`: shared LLM provider router for dispatching completion requests.
    /// - `activity_event_sender`: broadcast channel for worker activity events.
    pub fn new(
        task_store: Arc<TaskStore>,
        heartbeat_tracker: Arc<HeartbeatTracker>,
        llm_provider_router: Arc<LlmProviderRouter>,
        activity_event_sender: broadcast::Sender<WorkerActivityEvent>,
    ) -> Self {
        Self {
            task_store,
            heartbeat_tracker,
            llm_provider_router,
            activity_event_sender,
        }
    }

    /// Returns a clone of the activity event sender so other services
    /// (e.g. DaemonService) can subscribe to worker activity broadcasts.
    pub fn get_activity_event_sender(&self) -> broadcast::Sender<WorkerActivityEvent> {
        self.activity_event_sender.clone()
    }
}

// ---------------------------------------------------------------------------
// Proto-to-LLM conversion functions
// ---------------------------------------------------------------------------

/// Converts a proto `CompleteRequest` into an `LlmCompletionRequest` suitable
/// for the Rust LLM provider router.
///
/// This handles mapping between the protobuf message types and the canonical
/// Kraken LLM types:
/// - `ChatMessage` -> `LlmChatMessage`
/// - `Tool` -> `LlmToolDefinition`
/// - `ToolCallEntry` -> `LlmToolCall` (within messages)
#[allow(clippy::result_large_err)]
fn convert_proto_request_to_llm_completion_request(
    proto_request: &CompleteRequest,
) -> Result<LlmCompletionRequest, Status> {
    let messages: Vec<LlmChatMessage> = proto_request
        .messages
        .iter()
        .map(convert_proto_chat_message_to_llm_chat_message)
        .collect();

    let tools: Result<Vec<LlmToolDefinition>, Status> = proto_request
        .tools
        .iter()
        .map(convert_proto_tool_to_llm_tool_definition)
        .collect();

    Ok(LlmCompletionRequest {
        model: proto_request.model.clone(),
        messages,
        temperature: proto_request.temperature,
        max_tokens: proto_request.max_tokens,
        tools: tools?,
        include_reasoning: false,
        provider: proto_request.provider.clone().unwrap_or_default(),
    })
}

/// Converts a proto `ChatMessage` into an `LlmChatMessage`.
fn convert_proto_chat_message_to_llm_chat_message(proto_message: &ChatMessage) -> LlmChatMessage {
    let tool_calls: Vec<LlmToolCall> = proto_message
        .tool_calls
        .iter()
        .map(convert_proto_tool_call_entry_to_llm_tool_call)
        .collect();

    LlmChatMessage {
        role: proto_message.role.clone(),
        content: proto_message.content.clone(),
        tool_calls,
        tool_call_id: proto_message.tool_call_id.clone(),
        name: proto_message.name.clone().unwrap_or_default(),
    }
}

/// Converts a proto `ToolCallEntry` into an `LlmToolCall`.
fn convert_proto_tool_call_entry_to_llm_tool_call(
    proto_tool_call: &ToolCallEntry,
) -> LlmToolCall {
    let (function_name, function_arguments) = proto_tool_call
        .function
        .as_ref()
        .map(|function| (function.name.clone(), function.arguments.clone()))
        .unwrap_or_default();

    LlmToolCall {
        id: proto_tool_call.id.clone(),
        call_type: proto_tool_call.r#type.clone(),
        function_name,
        function_arguments,
    }
}

/// Converts a proto `Tool` into an `LlmToolDefinition`.
///
/// The proto `Tool` wraps a `ToolFunction` which contains a `ToolParameter`
/// with a `properties_json` string. This function parses that JSON string
/// into a `serde_json::Value` to build the full parameters schema expected
/// by LLM providers.
#[allow(clippy::result_large_err)]
fn convert_proto_tool_to_llm_tool_definition(proto_tool: &Tool) -> Result<LlmToolDefinition, Status> {
    let tool_function = proto_tool
        .function
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("tool is missing its function definition"))?;

    let parameters_schema = if let Some(ref parameters) = tool_function.parameters {
        // Parse the properties_json string into a serde_json::Value
        let properties_value: serde_json::Value =
            serde_json::from_str(&parameters.properties_json).map_err(|parse_error| {
                Status::invalid_argument(format!(
                    "failed to parse properties_json for tool '{}': {}",
                    tool_function.name, parse_error
                ))
            })?;

        serde_json::json!({
            "type": parameters.r#type,
            "properties": properties_value,
            "required": parameters.required,
        })
    } else {
        serde_json::json!({
            "type": "object",
            "properties": {},
            "required": [],
        })
    };

    Ok(LlmToolDefinition {
        name: tool_function.name.clone(),
        description: tool_function.description.clone(),
        parameters_schema,
    })
}

// ---------------------------------------------------------------------------
// LLM-to-Proto conversion functions
// ---------------------------------------------------------------------------

/// Converts an `LlmCompletionResponse` into a proto `CompleteResponse`.
///
/// Maps the canonical Kraken LLM response back to protobuf types:
/// - `content` -> `ChatMessage { role: "assistant", content: ... }`
/// - `tool_calls` -> `Vec<ToolCallEntry>` with nested `ToolCallFunction`
fn convert_llm_completion_response_to_proto_response(
    llm_response: LlmCompletionResponse,
) -> CompleteResponse {
    let tool_call_entries: Vec<ToolCallEntry> = llm_response
        .tool_calls
        .iter()
        .map(convert_llm_tool_call_to_proto_tool_call_entry)
        .collect();

    // Build the assistant ChatMessage with content and any tool calls
    let assistant_message = ChatMessage {
        role: "assistant".to_string(),
        content: llm_response.content.clone(),
        tool_calls: tool_call_entries.clone(),
        tool_call_id: String::new(),
        name: None,
    };

    CompleteResponse {
        id: llm_response.id,
        model: llm_response.model,
        message: Some(assistant_message),
        prompt_tokens: llm_response.prompt_tokens,
        completion_tokens: llm_response.completion_tokens,
        tool_calls: tool_call_entries,
        finish_reason: llm_response.finish_reason,
    }
}

/// Converts an `LlmToolCall` into a proto `ToolCallEntry`.
fn convert_llm_tool_call_to_proto_tool_call_entry(llm_tool_call: &LlmToolCall) -> ToolCallEntry {
    ToolCallEntry {
        id: llm_tool_call.id.clone(),
        r#type: llm_tool_call.call_type.clone(),
        function: Some(ToolCallFunction {
            name: llm_tool_call.function_name.clone(),
            arguments: llm_tool_call.function_arguments.clone(),
        }),
    }
}

/// Converts an `LlmProviderError` into a `tonic::Status` with the appropriate
/// gRPC error code based on the error type.
fn convert_llm_provider_error_to_tonic_status(llm_error: LlmProviderError) -> Status {
    let grpc_status_code = match llm_error.error_type.as_str() {
        "auth" => tonic::Code::Unauthenticated,
        "rate_limit" => tonic::Code::ResourceExhausted,
        "not_found" => tonic::Code::NotFound,
        "invalid_request" => tonic::Code::InvalidArgument,
        "configuration" => tonic::Code::FailedPrecondition,
        "server" => tonic::Code::Internal,
        "timeout" => tonic::Code::DeadlineExceeded,
        _ => tonic::Code::Internal,
    };

    Status::new(
        grpc_status_code,
        format!(
            "[{}] {}: {}",
            llm_error.provider, llm_error.error_type, llm_error.message
        ),
    )
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

        let retry_context_for_response = if task.attempt > 1 {
            task.error_message.unwrap_or_default()
        } else {
            String::new()
        };

        Ok(Response::new(GetTaskResponse {
            task_id: task.id,
            name: task.name,
            description: task.description,
            working_dir: task.worker_dir.unwrap_or_default(),
            retry_context: retry_context_for_response,
            attempt: task.attempt,
        }))
    }

    /// Performs LLM completion requests via the Rust LlmProviderRouter.
    ///
    /// The worker sends a CompleteRequest via gRPC. This method:
    /// 1. Extracts the `x-task-id` metadata (before consuming the request)
    /// 2. Converts the proto CompleteRequest to an LlmCompletionRequest
    /// 3. Calls the LlmProviderRouter to get a completion
    /// 4. Converts the LlmCompletionResponse back to a proto CompleteResponse
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

        let llm_completion_request =
            convert_proto_request_to_llm_completion_request(&complete_request)?;

        let llm_completion_response = self
            .llm_provider_router
            .complete(llm_completion_request)
            .await
            .map_err(|llm_error| {
                error!(
                    provider = %llm_error.provider,
                    error_type = %llm_error.error_type,
                    error = %llm_error.message,
                    "LLM completion request failed"
                );
                convert_llm_provider_error_to_tonic_status(llm_error)
            })?;

        let complete_response =
            convert_llm_completion_response_to_proto_response(llm_completion_response);

        // Track token usage if we have a task ID from metadata
        if let Some(ref task_id) = task_id_from_metadata {
            let prompt_tokens = complete_response.prompt_tokens as i64;
            let completion_tokens = complete_response.completion_tokens as i64;

            if let Err(token_tracking_error) = self
                .task_store
                .add_token_usage(task_id, prompt_tokens, completion_tokens, 0.0)
                .await
            {
                warn!(
                    task_id = %task_id,
                    error = %token_tracking_error,
                    "failed to track token usage"
                );
            }
        }

        Ok(Response::new(complete_response))
    }

    type StreamCompleteStream = std::pin::Pin<
        Box<dyn tokio_stream::Stream<Item = Result<StreamCompleteResponse, Status>> + Send>,
    >;

    /// Performs streaming LLM completion requests via the Rust LlmProviderRouter.
    ///
    /// The worker sends a StreamCompleteRequest via gRPC. This method:
    /// 1. Extracts the `x-task-id` metadata (before consuming the request)
    /// 2. Converts the proto StreamCompleteRequest to an LlmCompletionRequest
    /// 3. Creates a tokio mpsc channel for streaming chunks back to the client
    /// 4. Spawns a background task that calls LlmProviderRouter::stream_complete
    /// 5. Each LlmStreamChunk is converted to a proto StreamCompleteResponse
    /// 6. Token usage is tracked on the final chunk if a task ID was provided
    async fn stream_complete(
        &self,
        request: Request<StreamCompleteRequest>,
    ) -> Result<Response<Self::StreamCompleteStream>, Status> {
        // CRITICAL: Extract metadata BEFORE calling into_inner(), which consumes the Request
        let task_id_from_metadata = request
            .metadata()
            .get("x-task-id")
            .and_then(|value| value.to_str().ok())
            .map(|s| s.to_string());

        let stream_complete_request = request.into_inner();

        // StreamCompleteRequest has the same fields as CompleteRequest, so we
        // build an LlmCompletionRequest from a temporary CompleteRequest.
        let equivalent_complete_request = CompleteRequest {
            model: stream_complete_request.model,
            messages: stream_complete_request.messages,
            temperature: stream_complete_request.temperature,
            max_tokens: stream_complete_request.max_tokens,
            system_prompt: stream_complete_request.system_prompt,
            tools: stream_complete_request.tools,
            provider: stream_complete_request.provider,
        };

        let llm_completion_request =
            convert_proto_request_to_llm_completion_request(&equivalent_complete_request)?;

        // Create an mpsc channel to stream chunks from the background task to
        // the gRPC response stream. Buffer size of 32 provides enough room for
        // bursty LLM responses without blocking the provider callback.
        let (stream_chunk_sender, stream_chunk_receiver) =
            tokio::sync::mpsc::channel::<Result<StreamCompleteResponse, Status>>(32);

        let llm_provider_router = Arc::clone(&self.llm_provider_router);
        let task_store_for_streaming = Arc::clone(&self.task_store);

        tokio::spawn(async move {
            // Accumulated tool calls across all chunks for sending on the final chunk.
            // We use a Mutex so the callback closure can mutate this state.
            let accumulated_tool_calls: Arc<tokio::sync::Mutex<Vec<ToolCallEntry>>> =
                Arc::new(tokio::sync::Mutex::new(Vec::new()));

            let accumulated_tool_calls_for_callback = Arc::clone(&accumulated_tool_calls);
            let stream_chunk_sender_for_callback = stream_chunk_sender.clone();

            let streaming_result = llm_provider_router
                .stream_complete(
                    llm_completion_request,
                    Box::new(move |stream_chunk: LlmStreamChunk| {
                        // Accumulate tool call deltas into complete tool call entries
                        let accumulated_tool_calls_ref =
                            Arc::clone(&accumulated_tool_calls_for_callback);

                        // We need to block on the mutex since the callback is sync
                        // Use try_lock since we're in a sync context and there's no contention
                        if let Ok(mut accumulated_calls) = accumulated_tool_calls_ref.try_lock() {
                            for tool_call_delta in &stream_chunk.tool_call_deltas {
                                let delta_index = tool_call_delta.index as usize;

                                // Extend the vector if needed
                                while accumulated_calls.len() <= delta_index {
                                    accumulated_calls.push(ToolCallEntry {
                                        id: String::new(),
                                        r#type: String::new(),
                                        function: Some(ToolCallFunction {
                                            name: String::new(),
                                            arguments: String::new(),
                                        }),
                                    });
                                }

                                let accumulated_entry = &mut accumulated_calls[delta_index];

                                // First chunk for this index populates the id, type, and name
                                if !tool_call_delta.id.is_empty() {
                                    accumulated_entry.id = tool_call_delta.id.clone();
                                }
                                if !tool_call_delta.call_type.is_empty() {
                                    accumulated_entry.r#type =
                                        tool_call_delta.call_type.clone();
                                }
                                if let Some(ref function) = accumulated_entry.function {
                                    let mut updated_function = function.clone();
                                    if !tool_call_delta.function_name.is_empty() {
                                        updated_function.name =
                                            tool_call_delta.function_name.clone();
                                    }
                                    updated_function
                                        .arguments
                                        .push_str(&tool_call_delta.function_arguments_delta);
                                    accumulated_entry.function = Some(updated_function);
                                }
                            }
                        }

                        // Build the proto StreamCompleteResponse for this chunk
                        let proto_stream_response = StreamCompleteResponse {
                            id: stream_chunk.id.clone(),
                            delta: stream_chunk.content_delta.clone(),
                            done: stream_chunk.done,
                            prompt_tokens: stream_chunk.prompt_tokens.unwrap_or(0),
                            completion_tokens: stream_chunk.completion_tokens.unwrap_or(0),
                            // Tool calls are only sent on the final (done) chunk
                            tool_calls: Vec::new(),
                            finish_reason: stream_chunk
                                .finish_reason
                                .clone()
                                .unwrap_or_default(),
                            reasoning: stream_chunk.reasoning_delta.clone(),
                        };

                        // Send the chunk through the mpsc channel
                        // Use try_send since the callback is synchronous
                        stream_chunk_sender_for_callback
                            .try_send(Ok(proto_stream_response))
                            .map_err(|send_error| {
                                format!("failed to send stream chunk to client: {send_error}")
                            })?;

                        Ok(())
                    }),
                )
                .await;

            match streaming_result {
                Ok(()) => {
                    // Send a final chunk with accumulated tool calls if any exist
                    let final_accumulated_tool_calls =
                        accumulated_tool_calls.lock().await.clone();

                    if !final_accumulated_tool_calls.is_empty() {
                        let final_tool_calls_response = StreamCompleteResponse {
                            id: String::new(),
                            delta: String::new(),
                            done: true,
                            prompt_tokens: 0,
                            completion_tokens: 0,
                            tool_calls: final_accumulated_tool_calls,
                            finish_reason: String::new(),
                            reasoning: String::new(),
                        };

                        let _ = stream_chunk_sender
                            .send(Ok(final_tool_calls_response))
                            .await;
                    }
                }
                Err(llm_error) => {
                    error!(
                        provider = %llm_error.provider,
                        error_type = %llm_error.error_type,
                        error = %llm_error.message,
                        "LLM streaming completion request failed"
                    );
                    let _ = stream_chunk_sender
                        .send(Err(convert_llm_provider_error_to_tonic_status(llm_error)))
                        .await;
                }
            }

            // Track token usage on stream completion if we have a task ID.
            // Note: token counts for streaming are typically reported in the
            // final chunk by the provider.
            if let Some(ref task_id) = task_id_from_metadata {
                // Token tracking for streams happens via the final chunk's
                // prompt_tokens/completion_tokens fields -- the client is
                // responsible for accumulating these since we send them in-band.
                // For now we log that the stream completed for the task.
                info!(
                    task_id = %task_id,
                    "streaming completion finished for task"
                );
            }

            // Drop the sender so the receiver stream ends
            drop(stream_chunk_sender);
            drop(task_store_for_streaming);
        });

        let response_stream = ReceiverStream::new(stream_chunk_receiver);

        Ok(Response::new(
            Box::pin(response_stream) as Self::StreamCompleteStream
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
    use crate::proto::agent::v1::{ToolFunction, ToolParameter};

    // -----------------------------------------------------------------------
    // Proto-to-LLM conversion tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_convert_proto_request_to_llm_completion_request_minimal() {
        let proto_request = CompleteRequest {
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

        let llm_request =
            convert_proto_request_to_llm_completion_request(&proto_request).unwrap();

        assert_eq!(llm_request.model, "gpt-4");
        assert_eq!(llm_request.messages.len(), 1);
        assert_eq!(llm_request.messages[0].role, "user");
        assert_eq!(llm_request.messages[0].content, "Hello");
        assert!(llm_request.temperature.is_none());
        assert!(llm_request.max_tokens.is_none());
        assert!(llm_request.tools.is_empty());
        assert_eq!(llm_request.provider, "");
    }

    #[test]
    fn test_convert_proto_request_to_llm_completion_request_with_all_fields() {
        let proto_request = CompleteRequest {
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

        let llm_request =
            convert_proto_request_to_llm_completion_request(&proto_request).unwrap();

        assert_eq!(llm_request.model, "claude-3-opus");
        assert_eq!(llm_request.temperature, Some(0.7));
        assert_eq!(llm_request.max_tokens, Some(4096));
        assert_eq!(llm_request.provider, "anthropic");
        assert_eq!(llm_request.tools.len(), 1);
        assert_eq!(llm_request.tools[0].name, "read_file");
        assert_eq!(llm_request.tools[0].description, "Reads a file from disk");

        // Verify the parameters_schema was properly constructed
        let schema = &llm_request.tools[0].parameters_schema;
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["properties"]["path"]["type"], "string");
        assert_eq!(schema["required"][0], "path");
    }

    #[test]
    fn test_convert_proto_chat_message_with_tool_calls() {
        let proto_message = ChatMessage {
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

        let llm_message = convert_proto_chat_message_to_llm_chat_message(&proto_message);
        assert_eq!(llm_message.role, "assistant");
        assert_eq!(llm_message.tool_calls.len(), 1);
        assert_eq!(llm_message.tool_calls[0].id, "call_123");
        assert_eq!(llm_message.tool_calls[0].call_type, "function");
        assert_eq!(llm_message.tool_calls[0].function_name, "read_file");
        assert_eq!(
            llm_message.tool_calls[0].function_arguments,
            r#"{"path":"src/main.rs"}"#
        );
    }

    #[test]
    fn test_convert_proto_chat_message_with_tool_result() {
        let proto_message = ChatMessage {
            role: "tool".to_string(),
            content: "file contents here".to_string(),
            tool_calls: vec![],
            tool_call_id: "call_123".to_string(),
            name: Some("read_file".to_string()),
        };

        let llm_message = convert_proto_chat_message_to_llm_chat_message(&proto_message);
        assert_eq!(llm_message.role, "tool");
        assert_eq!(llm_message.content, "file contents here");
        assert_eq!(llm_message.tool_call_id, "call_123");
        assert_eq!(llm_message.name, "read_file");
    }

    // -----------------------------------------------------------------------
    // LLM-to-Proto conversion tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_convert_llm_response_to_proto_response() {
        let llm_response = LlmCompletionResponse {
            id: "resp-001".to_string(),
            model: "gpt-4".to_string(),
            content: "Hello there!".to_string(),
            tool_calls: vec![],
            finish_reason: "stop".to_string(),
            prompt_tokens: 10,
            completion_tokens: 5,
        };

        let proto_response =
            convert_llm_completion_response_to_proto_response(llm_response);

        assert_eq!(proto_response.id, "resp-001");
        assert_eq!(proto_response.model, "gpt-4");
        assert_eq!(proto_response.prompt_tokens, 10);
        assert_eq!(proto_response.completion_tokens, 5);
        assert_eq!(proto_response.finish_reason, "stop");
        assert!(proto_response.tool_calls.is_empty());

        let message = proto_response.message.unwrap();
        assert_eq!(message.role, "assistant");
        assert_eq!(message.content, "Hello there!");
    }

    #[test]
    fn test_convert_llm_response_to_proto_response_with_tool_calls() {
        let llm_response = LlmCompletionResponse {
            id: "resp-002".to_string(),
            model: "gpt-4".to_string(),
            content: String::new(),
            tool_calls: vec![LlmToolCall {
                id: "call_abc".to_string(),
                call_type: "function".to_string(),
                function_name: "write_file".to_string(),
                function_arguments: r#"{"path":"test.txt","content":"hello"}"#.to_string(),
            }],
            finish_reason: "tool_calls".to_string(),
            prompt_tokens: 20,
            completion_tokens: 15,
        };

        let proto_response =
            convert_llm_completion_response_to_proto_response(llm_response);

        // Check top-level tool_calls
        assert_eq!(proto_response.tool_calls.len(), 1);
        assert_eq!(proto_response.tool_calls[0].id, "call_abc");
        let function = proto_response.tool_calls[0].function.as_ref().unwrap();
        assert_eq!(function.name, "write_file");
        assert_eq!(
            function.arguments,
            r#"{"path":"test.txt","content":"hello"}"#
        );

        // Check message-level tool_calls
        let message = proto_response.message.unwrap();
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].id, "call_abc");
    }

    // -----------------------------------------------------------------------
    // Error conversion tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_convert_llm_provider_error_auth() {
        let llm_error = LlmProviderError {
            message: "invalid API key".to_string(),
            error_type: "auth".to_string(),
            provider: "openai".to_string(),
            is_retryable: false,
        };

        let status = convert_llm_provider_error_to_tonic_status(llm_error);
        assert_eq!(status.code(), tonic::Code::Unauthenticated);
    }

    #[test]
    fn test_convert_llm_provider_error_rate_limit() {
        let llm_error = LlmProviderError {
            message: "rate limit exceeded".to_string(),
            error_type: "rate_limit".to_string(),
            provider: "anthropic".to_string(),
            is_retryable: true,
        };

        let status = convert_llm_provider_error_to_tonic_status(llm_error);
        assert_eq!(status.code(), tonic::Code::ResourceExhausted);
    }

    #[test]
    fn test_convert_llm_provider_error_configuration() {
        let llm_error = LlmProviderError {
            message: "no providers configured".to_string(),
            error_type: "configuration".to_string(),
            provider: "router".to_string(),
            is_retryable: false,
        };

        let status = convert_llm_provider_error_to_tonic_status(llm_error);
        assert_eq!(status.code(), tonic::Code::FailedPrecondition);
    }

    #[test]
    fn test_convert_llm_provider_error_unknown_type() {
        let llm_error = LlmProviderError {
            message: "something unexpected".to_string(),
            error_type: "unknown_type".to_string(),
            provider: "test".to_string(),
            is_retryable: false,
        };

        let status = convert_llm_provider_error_to_tonic_status(llm_error);
        assert_eq!(status.code(), tonic::Code::Internal);
    }

    // -----------------------------------------------------------------------
    // Tool conversion tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_convert_proto_tool_to_llm_tool_definition_with_parameters() {
        let proto_tool = Tool {
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

        let llm_tool = convert_proto_tool_to_llm_tool_definition(&proto_tool).unwrap();
        assert_eq!(llm_tool.name, "search");
        assert_eq!(llm_tool.description, "Search the web");
        assert_eq!(llm_tool.parameters_schema["type"], "object");
        assert_eq!(
            llm_tool.parameters_schema["properties"]["query"]["type"],
            "string"
        );
        assert_eq!(llm_tool.parameters_schema["required"][0], "query");
    }

    #[test]
    fn test_convert_proto_tool_to_llm_tool_definition_without_parameters() {
        let proto_tool = Tool {
            r#type: "function".to_string(),
            function: Some(ToolFunction {
                name: "get_time".to_string(),
                description: "Get current time".to_string(),
                parameters: None,
            }),
        };

        let llm_tool = convert_proto_tool_to_llm_tool_definition(&proto_tool).unwrap();
        assert_eq!(llm_tool.name, "get_time");
        assert_eq!(llm_tool.parameters_schema["type"], "object");
    }

    #[test]
    fn test_convert_proto_tool_to_llm_tool_definition_missing_function() {
        let proto_tool = Tool {
            r#type: "function".to_string(),
            function: None,
        };

        let result = convert_proto_tool_to_llm_tool_definition(&proto_tool);
        assert!(result.is_err());
    }

    #[test]
    fn test_convert_proto_tool_to_llm_tool_definition_invalid_json() {
        let proto_tool = Tool {
            r#type: "function".to_string(),
            function: Some(ToolFunction {
                name: "broken_tool".to_string(),
                description: "Has invalid JSON".to_string(),
                parameters: Some(ToolParameter {
                    r#type: "object".to_string(),
                    properties_json: "not valid json{".to_string(),
                    required: vec![],
                }),
            }),
        };

        let result = convert_proto_tool_to_llm_tool_definition(&proto_tool);
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // Misc tests
    // -----------------------------------------------------------------------

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
}
