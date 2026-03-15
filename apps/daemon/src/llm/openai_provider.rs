use std::time::Duration;

use futures::StreamExt;
use serde::{Deserialize, Serialize};

use super::types::{
    LlmChatMessage, LlmCompletionRequest, LlmCompletionResponse, LlmProvider, LlmProviderError,
    LlmStreamChunk, LlmToolCall, LlmToolCallDelta, LlmToolDefinition,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default base URL for the OpenRouter API.
const OPENROUTER_DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";

/// Default base URL for the OpenAI API.
const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// Default base URL for the local Ollama instance.
const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";

/// HTTP connection pool idle timeout.
const HTTP_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// HTTP request timeout (generous for long LLM completions).
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

// ===========================================================================
// OpenAI-compatible request serialization types
// ===========================================================================

/// Top-level request body sent to the OpenAI chat completions endpoint.
#[derive(Debug, Serialize)]
struct OpenAiRequestBody {
    /// Model identifier to route to (e.g. "gpt-4o", "deepseek/deepseek-v3.2").
    model: String,

    /// Conversation history in OpenAI message format.
    messages: Vec<OpenAiRequestMessage>,

    /// Sampling temperature (0.0 - 2.0).
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,

    /// Maximum number of tokens to generate.
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<i32>,

    /// Whether to stream the response via SSE.
    stream: bool,

    /// Tool definitions available for the model to call.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<OpenAiRequestTool>,

    /// OpenRouter-specific flag to include chain-of-thought reasoning.
    #[serde(skip_serializing_if = "Option::is_none")]
    include_reasoning: Option<bool>,
}

/// A single message in the OpenAI chat format.
#[derive(Debug, Serialize)]
struct OpenAiRequestMessage {
    /// Role of the message author: "system", "user", "assistant", or "tool".
    role: String,

    /// Text content of the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,

    /// Tool calls requested by the assistant (only for assistant messages).
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<OpenAiRequestToolCall>>,

    /// Identifier linking a tool-result message to the originating tool call.
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,

    /// Optional sender name within a multi-participant conversation.
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

/// A tool call entry within an assistant request message.
#[derive(Debug, Serialize)]
struct OpenAiRequestToolCall {
    /// Unique identifier for this tool call.
    id: String,

    /// Type of the tool call -- always "function".
    #[serde(rename = "type")]
    call_type: String,

    /// The function to invoke.
    function: OpenAiRequestFunction,
}

/// Function name and arguments within a tool call request.
#[derive(Debug, Serialize)]
struct OpenAiRequestFunction {
    /// Name of the function to call.
    name: String,

    /// JSON-encoded string of arguments.
    arguments: String,
}

/// A tool definition in the OpenAI format.
#[derive(Debug, Serialize)]
struct OpenAiRequestTool {
    /// Type of tool -- always "function".
    #[serde(rename = "type")]
    tool_type: String,

    /// The function specification.
    function: OpenAiRequestToolFunction,
}

/// Function metadata within a tool definition.
#[derive(Debug, Serialize)]
struct OpenAiRequestToolFunction {
    /// The name of the function.
    name: String,

    /// Human-readable description of what the function does.
    description: String,

    /// JSON Schema describing the function's parameters.
    parameters: serde_json::Value,
}

// ===========================================================================
// OpenAI-compatible response deserialization types (non-streaming)
// ===========================================================================

/// Top-level response body from the OpenAI chat completions endpoint.
#[derive(Debug, Deserialize)]
struct OpenAiResponseBody {
    /// Provider-assigned response identifier.
    #[serde(default)]
    id: String,

    /// Model that produced the response.
    #[serde(default)]
    model: String,

    /// List of completion choices (typically length 1).
    #[serde(default)]
    choices: Vec<OpenAiResponseChoice>,

    /// Token usage statistics.
    #[serde(default)]
    usage: Option<OpenAiResponseUsage>,

    /// Error information if the request failed at the provider level.
    #[serde(default)]
    error: Option<OpenAiResponseError>,
}

/// A single completion choice in the non-streaming response.
#[derive(Debug, Deserialize)]
struct OpenAiResponseChoice {
    /// The assistant message generated by the model.
    #[serde(default)]
    message: OpenAiResponseMessage,

    /// Reason generation stopped: "stop", "tool_calls", "length", etc.
    #[serde(default)]
    finish_reason: Option<String>,
}

/// The assistant message within a non-streaming response choice.
#[derive(Debug, Default, Deserialize)]
struct OpenAiResponseMessage {
    /// Role of the message (always "assistant" in responses).
    #[serde(default)]
    #[allow(dead_code)]
    role: String,

    /// Text content of the response (may be null when tool calls are present).
    #[serde(default)]
    content: Option<String>,

    /// Tool calls the model wants to execute.
    #[serde(default)]
    tool_calls: Option<Vec<OpenAiResponseToolCall>>,
}

/// A tool call entry within a non-streaming assistant response.
#[derive(Debug, Deserialize)]
struct OpenAiResponseToolCall {
    /// Unique identifier for this tool call.
    #[serde(default)]
    id: String,

    /// Type of the tool call -- always "function".
    #[serde(default, rename = "type")]
    call_type: String,

    /// The function being called.
    #[serde(default)]
    function: OpenAiResponseFunction,
}

/// Function name and arguments within a non-streaming tool call response.
#[derive(Debug, Default, Deserialize)]
struct OpenAiResponseFunction {
    /// Name of the function to call.
    #[serde(default)]
    name: String,

    /// JSON-encoded string of arguments.
    #[serde(default)]
    arguments: String,
}

/// Token usage statistics from the completions response.
#[derive(Debug, Default, Deserialize)]
struct OpenAiResponseUsage {
    /// Number of tokens in the prompt.
    #[serde(default)]
    prompt_tokens: i32,

    /// Number of tokens generated in the completion.
    #[serde(default)]
    completion_tokens: i32,
}

/// Error object returned by the OpenAI API when a request fails.
#[derive(Debug, Deserialize)]
struct OpenAiResponseError {
    /// Human-readable error description.
    #[serde(default)]
    message: String,

    /// Error category (e.g. "invalid_request_error", "rate_limit_error").
    #[serde(default, rename = "type")]
    error_type: String,
}

// ===========================================================================
// OpenAI-compatible streaming (SSE) deserialization types
// ===========================================================================

/// A single SSE chunk from the streaming completions endpoint.
#[derive(Debug, Deserialize)]
struct OpenAiStreamChunkBody {
    /// Provider-assigned response identifier (same across all chunks).
    #[serde(default)]
    id: String,

    /// Model that produced this chunk.
    #[serde(default)]
    model: String,

    /// List of streaming choices (typically length 1).
    #[serde(default)]
    choices: Vec<OpenAiStreamChoice>,

    /// Token usage -- only populated in the final chunk of some providers.
    #[serde(default)]
    usage: Option<OpenAiResponseUsage>,

    /// Error that may appear mid-stream.
    #[serde(default)]
    error: Option<OpenAiResponseError>,
}

/// A single streaming choice containing the incremental delta.
#[derive(Debug, Deserialize)]
struct OpenAiStreamChoice {
    /// The incremental content delta for this chunk.
    #[serde(default)]
    delta: OpenAiStreamDelta,

    /// Finish reason -- set only on the final choice chunk.
    #[serde(default)]
    finish_reason: Option<String>,
}

/// Incremental delta content within a streaming choice.
#[derive(Debug, Default, Deserialize)]
struct OpenAiStreamDelta {
    /// Incremental text content fragment.
    #[serde(default)]
    content: Option<String>,

    /// Incremental reasoning fragment (OpenRouter field name).
    #[serde(default)]
    reasoning: Option<String>,

    /// Incremental reasoning fragment (alternative field name used by some providers).
    #[serde(default)]
    reasoning_content: Option<String>,

    /// Incremental tool call deltas.
    #[serde(default)]
    tool_calls: Option<Vec<OpenAiStreamToolCallDelta>>,
}

/// An incremental tool call delta within a streaming chunk.
#[derive(Debug, Deserialize)]
struct OpenAiStreamToolCallDelta {
    /// Index of the tool call this delta belongs to (supports parallel calls).
    #[serde(default)]
    index: usize,

    /// Tool-call identifier, populated in the first chunk for this index.
    #[serde(default)]
    id: Option<String>,

    /// Call type, populated in the first chunk (always "function").
    #[serde(default, rename = "type")]
    call_type: Option<String>,

    /// Incremental function name and arguments.
    #[serde(default)]
    function: Option<OpenAiStreamToolCallFunctionDelta>,
}

/// Incremental function fields within a streaming tool call delta.
#[derive(Debug, Default, Deserialize)]
struct OpenAiStreamToolCallFunctionDelta {
    /// Function name (populated in the first chunk for this tool call index).
    #[serde(default)]
    name: Option<String>,

    /// Incremental fragment of the JSON-encoded arguments string.
    #[serde(default)]
    arguments: Option<String>,
}

// ===========================================================================
// Provider implementation
// ===========================================================================

/// An LLM provider that speaks the OpenAI-compatible chat completions protocol.
///
/// This single provider handles OpenRouter, OpenAI, and Ollama since they all
/// share the same API format. Provider-specific adjustments (such as the
/// `include_reasoning` flag for OpenRouter) are handled internally.
pub struct OpenAiCompatibleProvider {
    /// Canonical name of the provider: "openrouter", "openai", or "ollama".
    provider_name: String,

    /// Bearer token for API authentication.
    api_key: String,

    /// Base URL for the chat completions endpoint (without trailing slash).
    base_url: String,

    /// Reusable HTTP client with connection pooling.
    http_client: reqwest::Client,
}

impl OpenAiCompatibleProvider {
    /// Create a new OpenAI-compatible provider.
    ///
    /// If `base_url` is empty, the default URL for the given `provider_name`
    /// will be used:
    /// - `"openrouter"` -> `https://openrouter.ai/api/v1`
    /// - `"openai"` -> `https://api.openai.com/v1`
    /// - `"ollama"` -> `http://localhost:11434/v1`
    pub fn new(provider_name: &str, api_key: &str, base_url: &str) -> Self {
        let resolved_base_url = if base_url.is_empty() {
            match provider_name {
                "openai" => OPENAI_DEFAULT_BASE_URL.to_string(),
                "ollama" => OLLAMA_DEFAULT_BASE_URL.to_string(),
                _ => OPENROUTER_DEFAULT_BASE_URL.to_string(),
            }
        } else {
            base_url.trim_end_matches('/').to_string()
        };

        let http_client = reqwest::Client::builder()
            .pool_idle_timeout(HTTP_POOL_IDLE_TIMEOUT)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest HTTP client");

        Self {
            provider_name: provider_name.to_string(),
            api_key: api_key.to_string(),
            base_url: resolved_base_url,
            http_client,
        }
    }

    // -----------------------------------------------------------------------
    // Message conversion helpers
    // -----------------------------------------------------------------------

    /// Convert internal chat messages to the OpenAI wire format.
    fn convert_messages_to_openai_format(
        messages: &[LlmChatMessage],
    ) -> Vec<OpenAiRequestMessage> {
        messages
            .iter()
            .map(|message| {
                let tool_calls = if message.tool_calls.is_empty() {
                    None
                } else {
                    Some(
                        message
                            .tool_calls
                            .iter()
                            .map(|tool_call| OpenAiRequestToolCall {
                                id: tool_call.id.clone(),
                                call_type: tool_call.call_type.clone(),
                                function: OpenAiRequestFunction {
                                    name: tool_call.function_name.clone(),
                                    arguments: tool_call.function_arguments.clone(),
                                },
                            })
                            .collect(),
                    )
                };

                let tool_call_id = if message.tool_call_id.is_empty() {
                    None
                } else {
                    Some(message.tool_call_id.clone())
                };

                let name = if message.name.is_empty() {
                    None
                } else {
                    Some(message.name.clone())
                };

                let content = if message.content.is_empty() && tool_calls.is_some() {
                    None
                } else {
                    Some(message.content.clone())
                };

                OpenAiRequestMessage {
                    role: message.role.clone(),
                    content,
                    tool_calls,
                    tool_call_id,
                    name,
                }
            })
            .collect()
    }

    /// Convert internal tool definitions to the OpenAI wire format.
    fn convert_tools_to_openai_format(
        tools: &[LlmToolDefinition],
    ) -> Vec<OpenAiRequestTool> {
        tools
            .iter()
            .map(|tool| OpenAiRequestTool {
                tool_type: "function".to_string(),
                function: OpenAiRequestToolFunction {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    parameters: tool.parameters_schema.clone(),
                },
            })
            .collect()
    }

    /// Build the JSON request body for a completion call.
    fn build_request_body(
        &self,
        request: &LlmCompletionRequest,
        stream: bool,
    ) -> OpenAiRequestBody {
        let include_reasoning = if self.provider_name == "openrouter" && request.include_reasoning {
            Some(true)
        } else {
            None
        };

        OpenAiRequestBody {
            model: request.model.clone(),
            messages: Self::convert_messages_to_openai_format(&request.messages),
            temperature: request.temperature,
            max_tokens: request.max_tokens,
            stream,
            tools: Self::convert_tools_to_openai_format(&request.tools),
            include_reasoning,
        }
    }

    /// Construct the chat completions endpoint URL.
    fn chat_completions_url(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }

    /// Create an `LlmProviderError` from an HTTP status and response body.
    fn build_http_error(&self, status: reqwest::StatusCode, body: &str) -> LlmProviderError {
        let is_retryable = status.is_server_error()
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::REQUEST_TIMEOUT;

        let error_type = if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
        {
            "auth".to_string()
        } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            "rate_limit".to_string()
        } else if status.is_server_error() {
            "server".to_string()
        } else {
            "request".to_string()
        };

        LlmProviderError {
            message: format!(
                "{} returned HTTP {}: {}",
                self.provider_name,
                status.as_u16(),
                truncate_error_body(body, 500),
            ),
            error_type,
            provider: self.provider_name.clone(),
            is_retryable,
        }
    }

    /// Create an `LlmProviderError` from an API-level error object.
    fn build_api_error(&self, error: &OpenAiResponseError) -> LlmProviderError {
        let is_retryable = error.error_type == "rate_limit_error"
            || error.error_type == "server_error"
            || error.error_type == "overloaded_error";

        LlmProviderError {
            message: format!(
                "{} API error: {} (type={})",
                self.provider_name, error.message, error.error_type,
            ),
            error_type: error.error_type.clone(),
            provider: self.provider_name.clone(),
            is_retryable,
        }
    }

    /// Create an `LlmProviderError` from a reqwest transport error.
    fn build_transport_error(&self, error: &reqwest::Error) -> LlmProviderError {
        let is_retryable = error.is_timeout() || error.is_connect();

        let error_type = if error.is_timeout() {
            "timeout".to_string()
        } else if error.is_connect() {
            "connection".to_string()
        } else {
            "transport".to_string()
        };

        LlmProviderError {
            message: format!("{} transport error: {}", self.provider_name, error),
            error_type,
            provider: self.provider_name.clone(),
            is_retryable,
        }
    }

    /// Convert tool calls from the OpenAI response format to internal format.
    fn convert_response_tool_calls(
        tool_calls: Option<Vec<OpenAiResponseToolCall>>,
    ) -> Vec<LlmToolCall> {
        match tool_calls {
            Some(calls) => calls
                .into_iter()
                .map(|tool_call| LlmToolCall {
                    id: tool_call.id,
                    call_type: tool_call.call_type,
                    function_name: tool_call.function.name,
                    function_arguments: tool_call.function.arguments,
                })
                .collect(),
            None => Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// LlmProvider trait implementation
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
impl LlmProvider for OpenAiCompatibleProvider {
    /// Perform a non-streaming completion request against the OpenAI-compatible API.
    async fn complete(
        &self,
        request: LlmCompletionRequest,
    ) -> Result<LlmCompletionResponse, LlmProviderError> {
        let request_body = self.build_request_body(&request, false);

        let serialized_body = serde_json::to_string(&request_body).map_err(|serialization_error| {
            LlmProviderError {
                message: format!("failed to serialize request body: {serialization_error}"),
                error_type: "serialization".to_string(),
                provider: self.provider_name.clone(),
                is_retryable: false,
            }
        })?;

        let mut http_request = self
            .http_client
            .post(self.chat_completions_url())
            .header("Content-Type", "application/json");

        if !self.api_key.is_empty() {
            http_request = http_request.header("Authorization", format!("Bearer {}", self.api_key));
        }

        let http_response = http_request
            .body(serialized_body)
            .send()
            .await
            .map_err(|send_error| self.build_transport_error(&send_error))?;

        let response_status = http_response.status();

        let response_body_text = http_response
            .text()
            .await
            .map_err(|read_error| self.build_transport_error(&read_error))?;

        if !response_status.is_success() {
            return Err(self.build_http_error(response_status, &response_body_text));
        }

        let parsed_response: OpenAiResponseBody =
            serde_json::from_str(&response_body_text).map_err(|parse_error| LlmProviderError {
                message: format!(
                    "failed to parse response JSON: {parse_error} (body: {})",
                    truncate_error_body(&response_body_text, 500),
                ),
                error_type: "deserialization".to_string(),
                provider: self.provider_name.clone(),
                is_retryable: false,
            })?;

        // Check for API-level error in the response body.
        if let Some(ref api_error) = parsed_response.error {
            return Err(self.build_api_error(api_error));
        }

        // Extract the first choice (there is always exactly one in normal usage).
        let first_choice = parsed_response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| LlmProviderError {
                message: format!(
                    "{} returned a response with no choices",
                    self.provider_name,
                ),
                error_type: "empty_response".to_string(),
                provider: self.provider_name.clone(),
                is_retryable: false,
            })?;

        let usage = parsed_response.usage.unwrap_or_default();

        Ok(LlmCompletionResponse {
            id: parsed_response.id,
            model: parsed_response.model,
            content: first_choice.message.content.unwrap_or_default(),
            tool_calls: Self::convert_response_tool_calls(first_choice.message.tool_calls),
            finish_reason: first_choice.finish_reason.unwrap_or_default(),
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
        })
    }

    /// Perform a streaming completion request, calling `callback` for each SSE chunk.
    async fn stream_complete(
        &self,
        request: LlmCompletionRequest,
        callback: Box<dyn Fn(LlmStreamChunk) -> Result<(), String> + Send>,
    ) -> Result<(), LlmProviderError> {
        let request_body = self.build_request_body(&request, true);

        let serialized_body = serde_json::to_string(&request_body).map_err(|serialization_error| {
            LlmProviderError {
                message: format!("failed to serialize request body: {serialization_error}"),
                error_type: "serialization".to_string(),
                provider: self.provider_name.clone(),
                is_retryable: false,
            }
        })?;

        let mut http_request = self
            .http_client
            .post(self.chat_completions_url())
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream");

        if !self.api_key.is_empty() {
            http_request = http_request.header("Authorization", format!("Bearer {}", self.api_key));
        }

        let http_response = http_request
            .body(serialized_body)
            .send()
            .await
            .map_err(|send_error| self.build_transport_error(&send_error))?;

        let response_status = http_response.status();

        if !response_status.is_success() {
            let error_body_text = http_response
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read error body>".to_string());
            return Err(self.build_http_error(response_status, &error_body_text));
        }

        // Read the SSE stream using bytes_stream for incremental processing.
        let mut byte_stream = http_response.bytes_stream();
        let mut line_buffer = String::new();
        let mut chunks_received: u64 = 0;
        let mut received_done_marker = false;

        while let Some(chunk_result) = byte_stream.next().await {
            let chunk_bytes = chunk_result.map_err(|stream_error| {
                LlmProviderError {
                    message: format!(
                        "{} stream read error after {chunks_received} chunks: {stream_error}",
                        self.provider_name,
                    ),
                    error_type: "stream".to_string(),
                    provider: self.provider_name.clone(),
                    is_retryable: true,
                }
            })?;

            // Append raw bytes to the line buffer. SSE is always UTF-8.
            let chunk_text = String::from_utf8_lossy(&chunk_bytes);
            line_buffer.push_str(&chunk_text);

            // Process complete lines from the buffer.
            while let Some(newline_position) = line_buffer.find('\n') {
                let line = line_buffer[..newline_position].trim_end_matches('\r').to_string();
                line_buffer = line_buffer[newline_position + 1..].to_string();

                // Only process lines that start with the SSE "data: " prefix.
                let Some(data_payload) = line.strip_prefix("data: ") else {
                    continue;
                };

                let data_payload = data_payload.trim();

                // The "[DONE]" sentinel marks the end of the stream.
                if data_payload == "[DONE]" {
                    received_done_marker = true;
                    break;
                }

                // Parse the JSON chunk, skipping malformed data gracefully.
                let parsed_chunk: OpenAiStreamChunkBody = match serde_json::from_str(data_payload) {
                    Ok(chunk) => chunk,
                    Err(parse_error) => {
                        tracing::warn!(
                            provider = %self.provider_name,
                            error = %parse_error,
                            data = %truncate_error_body(data_payload, 200),
                            "skipping malformed SSE chunk",
                        );
                        continue;
                    }
                };

                // Check for errors embedded in the stream.
                if let Some(ref stream_error) = parsed_chunk.error {
                    return Err(self.build_api_error(stream_error));
                }

                // Convert the parsed SSE chunk to our internal stream chunk type.
                let internal_chunk =
                    self.convert_stream_chunk_to_internal_format(&parsed_chunk);

                chunks_received += 1;

                // Deliver the chunk to the caller.
                callback(internal_chunk).map_err(|callback_error| LlmProviderError {
                    message: format!("stream callback returned error: {callback_error}"),
                    error_type: "callback".to_string(),
                    provider: self.provider_name.clone(),
                    is_retryable: false,
                })?;
            }

            if received_done_marker {
                break;
            }
        }

        if !received_done_marker && chunks_received == 0 {
            return Err(LlmProviderError {
                message: format!(
                    "{} stream ended without data (no chunks received, no [DONE] marker)",
                    self.provider_name,
                ),
                error_type: "empty_stream".to_string(),
                provider: self.provider_name.clone(),
                is_retryable: true,
            });
        }

        Ok(())
    }

    /// Return the canonical name of this provider.
    fn provider_name(&self) -> &str {
        &self.provider_name
    }
}

impl OpenAiCompatibleProvider {
    /// Convert an OpenAI SSE stream chunk to the internal `LlmStreamChunk` type.
    fn convert_stream_chunk_to_internal_format(
        &self,
        chunk: &OpenAiStreamChunkBody,
    ) -> LlmStreamChunk {
        let first_choice = chunk.choices.first();

        let content_delta = first_choice
            .and_then(|choice| choice.delta.content.as_deref())
            .unwrap_or("")
            .to_string();

        // Reasoning can come from either the `reasoning` or `reasoning_content` field.
        let reasoning_delta = first_choice
            .and_then(|choice| {
                choice
                    .delta
                    .reasoning
                    .as_deref()
                    .or(choice.delta.reasoning_content.as_deref())
            })
            .unwrap_or("")
            .to_string();

        let tool_call_deltas = first_choice
            .and_then(|choice| choice.delta.tool_calls.as_ref())
            .map(|deltas| {
                deltas
                    .iter()
                    .map(|delta| {
                        let function_ref = delta.function.as_ref();
                        LlmToolCallDelta {
                            index: delta.index as i32,
                            id: delta.id.clone().unwrap_or_default(),
                            call_type: delta.call_type.clone().unwrap_or_default(),
                            function_name: function_ref
                                .and_then(|f| f.name.clone())
                                .unwrap_or_default(),
                            function_arguments_delta: function_ref
                                .and_then(|f| f.arguments.clone())
                                .unwrap_or_default(),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let finish_reason = first_choice.and_then(|choice| choice.finish_reason.clone());

        let (prompt_tokens, completion_tokens) = chunk
            .usage
            .as_ref()
            .map(|usage| (Some(usage.prompt_tokens), Some(usage.completion_tokens)))
            .unwrap_or((None, None));

        let done = finish_reason.is_some();

        LlmStreamChunk {
            id: chunk.id.clone(),
            model: chunk.model.clone(),
            content_delta,
            reasoning_delta,
            tool_call_deltas,
            finish_reason,
            prompt_tokens,
            completion_tokens,
            done,
        }
    }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/// Truncate a string for inclusion in error messages, appending "..." if truncated.
fn truncate_error_body(body: &str, max_length: usize) -> String {
    if body.len() <= max_length {
        body.to_string()
    } else {
        format!("{}...", &body[..max_length])
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_creation_with_default_openrouter_base_url() {
        let provider = OpenAiCompatibleProvider::new("openrouter", "test-key", "");
        assert_eq!(provider.provider_name(), "openrouter");
        assert_eq!(provider.base_url, OPENROUTER_DEFAULT_BASE_URL);
        assert_eq!(provider.api_key, "test-key");
    }

    #[test]
    fn test_provider_creation_with_default_openai_base_url() {
        let provider = OpenAiCompatibleProvider::new("openai", "sk-test", "");
        assert_eq!(provider.provider_name(), "openai");
        assert_eq!(provider.base_url, OPENAI_DEFAULT_BASE_URL);
    }

    #[test]
    fn test_provider_creation_with_default_ollama_base_url() {
        let provider = OpenAiCompatibleProvider::new("ollama", "", "");
        assert_eq!(provider.provider_name(), "ollama");
        assert_eq!(provider.base_url, OLLAMA_DEFAULT_BASE_URL);
    }

    #[test]
    fn test_provider_creation_with_custom_base_url() {
        let provider =
            OpenAiCompatibleProvider::new("openai", "key", "https://custom.api.com/v1/");
        assert_eq!(provider.base_url, "https://custom.api.com/v1");
    }

    #[test]
    fn test_chat_completions_url_construction() {
        let provider = OpenAiCompatibleProvider::new("openai", "key", "https://api.example.com/v1");
        assert_eq!(
            provider.chat_completions_url(),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_message_conversion_with_simple_user_message() {
        let messages = vec![LlmChatMessage {
            role: "user".to_string(),
            content: "Hello".to_string(),
            tool_calls: vec![],
            tool_call_id: String::new(),
            name: String::new(),
        }];

        let converted = OpenAiCompatibleProvider::convert_messages_to_openai_format(&messages);

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].role, "user");
        assert_eq!(converted[0].content.as_deref(), Some("Hello"));
        assert!(converted[0].tool_calls.is_none());
        assert!(converted[0].tool_call_id.is_none());
        assert!(converted[0].name.is_none());
    }

    #[test]
    fn test_message_conversion_with_assistant_tool_calls() {
        let messages = vec![LlmChatMessage {
            role: "assistant".to_string(),
            content: String::new(),
            tool_calls: vec![LlmToolCall {
                id: "call_123".to_string(),
                call_type: "function".to_string(),
                function_name: "get_weather".to_string(),
                function_arguments: r#"{"city":"London"}"#.to_string(),
            }],
            tool_call_id: String::new(),
            name: String::new(),
        }];

        let converted = OpenAiCompatibleProvider::convert_messages_to_openai_format(&messages);

        assert_eq!(converted.len(), 1);
        // Content is None because it's empty and tool_calls are present.
        assert!(converted[0].content.is_none());
        let tool_calls = converted[0].tool_calls.as_ref().unwrap();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_123");
        assert_eq!(tool_calls[0].function.name, "get_weather");
    }

    #[test]
    fn test_message_conversion_with_tool_result_message() {
        let messages = vec![LlmChatMessage {
            role: "tool".to_string(),
            content: r#"{"temp": 15}"#.to_string(),
            tool_calls: vec![],
            tool_call_id: "call_123".to_string(),
            name: "get_weather".to_string(),
        }];

        let converted = OpenAiCompatibleProvider::convert_messages_to_openai_format(&messages);

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].role, "tool");
        assert_eq!(
            converted[0].tool_call_id.as_deref(),
            Some("call_123")
        );
        assert_eq!(converted[0].name.as_deref(), Some("get_weather"));
    }

    #[test]
    fn test_tool_definition_conversion() {
        let tools = vec![LlmToolDefinition {
            name: "read_file".to_string(),
            description: "Read a file from disk".to_string(),
            parameters_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                }
            }),
        }];

        let converted = OpenAiCompatibleProvider::convert_tools_to_openai_format(&tools);

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].tool_type, "function");
        assert_eq!(converted[0].function.name, "read_file");
        assert_eq!(converted[0].function.description, "Read a file from disk");
    }

    #[test]
    fn test_request_body_includes_reasoning_only_for_openrouter() {
        let openrouter_provider = OpenAiCompatibleProvider::new("openrouter", "key", "");
        let openai_provider = OpenAiCompatibleProvider::new("openai", "key", "");

        let request = LlmCompletionRequest {
            model: "test-model".to_string(),
            messages: vec![],
            temperature: None,
            max_tokens: None,
            tools: vec![],
            include_reasoning: true,
            provider: "openrouter".to_string(),
        };

        let openrouter_body = openrouter_provider.build_request_body(&request, false);
        assert_eq!(openrouter_body.include_reasoning, Some(true));

        let openai_body = openai_provider.build_request_body(&request, false);
        assert!(openai_body.include_reasoning.is_none());
    }

    #[test]
    fn test_request_body_serialization_omits_none_fields() {
        let provider = OpenAiCompatibleProvider::new("openai", "key", "");
        let request = LlmCompletionRequest {
            model: "gpt-4o".to_string(),
            messages: vec![LlmChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            }],
            temperature: None,
            max_tokens: None,
            tools: vec![],
            include_reasoning: false,
            provider: "openai".to_string(),
        };

        let body = provider.build_request_body(&request, false);
        let json_string = serde_json::to_string(&body).unwrap();

        assert!(!json_string.contains("temperature"));
        assert!(!json_string.contains("max_tokens"));
        assert!(!json_string.contains("include_reasoning"));
        assert!(!json_string.contains("tools"));
        assert!(json_string.contains("\"model\":\"gpt-4o\""));
        assert!(json_string.contains("\"stream\":false"));
    }

    #[test]
    fn test_non_streaming_response_deserialization() {
        let response_json = r#"{
            "id": "chatcmpl-abc123",
            "model": "gpt-4o",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "Hello! How can I help you?"
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 7
            }
        }"#;

        let parsed: OpenAiResponseBody = serde_json::from_str(response_json).unwrap();

        assert_eq!(parsed.id, "chatcmpl-abc123");
        assert_eq!(parsed.model, "gpt-4o");
        assert_eq!(parsed.choices.len(), 1);
        assert_eq!(
            parsed.choices[0].message.content.as_deref(),
            Some("Hello! How can I help you?")
        );
        assert_eq!(
            parsed.choices[0].finish_reason.as_deref(),
            Some("stop")
        );
        assert_eq!(parsed.usage.as_ref().unwrap().prompt_tokens, 10);
        assert_eq!(parsed.usage.as_ref().unwrap().completion_tokens, 7);
    }

    #[test]
    fn test_non_streaming_response_with_tool_calls() {
        let response_json = r#"{
            "id": "chatcmpl-xyz",
            "model": "gpt-4o",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_abc",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": "{\"city\":\"London\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {
                "prompt_tokens": 50,
                "completion_tokens": 20
            }
        }"#;

        let parsed: OpenAiResponseBody = serde_json::from_str(response_json).unwrap();
        let tool_calls = parsed.choices[0].message.tool_calls.as_ref().unwrap();

        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_abc");
        assert_eq!(tool_calls[0].call_type, "function");
        assert_eq!(tool_calls[0].function.name, "get_weather");
        assert_eq!(tool_calls[0].function.arguments, r#"{"city":"London"}"#);
    }

    #[test]
    fn test_non_streaming_response_with_error() {
        let response_json = r#"{
            "error": {
                "message": "Rate limit exceeded",
                "type": "rate_limit_error"
            }
        }"#;

        let parsed: OpenAiResponseBody = serde_json::from_str(response_json).unwrap();
        let error = parsed.error.as_ref().unwrap();

        assert_eq!(error.message, "Rate limit exceeded");
        assert_eq!(error.error_type, "rate_limit_error");
    }

    #[test]
    fn test_streaming_chunk_deserialization() {
        let chunk_json = r#"{
            "id": "chatcmpl-abc",
            "model": "gpt-4o",
            "choices": [{
                "delta": {
                    "content": "Hello"
                },
                "finish_reason": null
            }]
        }"#;

        let parsed: OpenAiStreamChunkBody = serde_json::from_str(chunk_json).unwrap();

        assert_eq!(parsed.id, "chatcmpl-abc");
        assert_eq!(parsed.choices[0].delta.content.as_deref(), Some("Hello"));
        assert!(parsed.choices[0].finish_reason.is_none());
    }

    #[test]
    fn test_streaming_chunk_with_tool_call_delta() {
        let chunk_json = r#"{
            "id": "chatcmpl-abc",
            "model": "gpt-4o",
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_xyz",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": ""
                        }
                    }]
                },
                "finish_reason": null
            }]
        }"#;

        let parsed: OpenAiStreamChunkBody = serde_json::from_str(chunk_json).unwrap();
        let tool_calls = parsed.choices[0].delta.tool_calls.as_ref().unwrap();

        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].index, 0);
        assert_eq!(tool_calls[0].id.as_deref(), Some("call_xyz"));
        assert_eq!(tool_calls[0].call_type.as_deref(), Some("function"));
        assert_eq!(
            tool_calls[0].function.as_ref().unwrap().name.as_deref(),
            Some("read_file")
        );
    }

    #[test]
    fn test_streaming_chunk_with_reasoning_field() {
        let chunk_json = r#"{
            "id": "chatcmpl-abc",
            "model": "deepseek/deepseek-r1",
            "choices": [{
                "delta": {
                    "reasoning": "Let me think about this..."
                },
                "finish_reason": null
            }]
        }"#;

        let parsed: OpenAiStreamChunkBody = serde_json::from_str(chunk_json).unwrap();

        assert_eq!(
            parsed.choices[0].delta.reasoning.as_deref(),
            Some("Let me think about this...")
        );
    }

    #[test]
    fn test_streaming_chunk_with_reasoning_content_field() {
        let chunk_json = r#"{
            "id": "chatcmpl-abc",
            "model": "some-model",
            "choices": [{
                "delta": {
                    "reasoning_content": "Alternative reasoning field..."
                },
                "finish_reason": null
            }]
        }"#;

        let parsed: OpenAiStreamChunkBody = serde_json::from_str(chunk_json).unwrap();

        assert_eq!(
            parsed.choices[0].delta.reasoning_content.as_deref(),
            Some("Alternative reasoning field...")
        );
    }

    #[test]
    fn test_streaming_chunk_with_finish_reason_and_usage() {
        let chunk_json = r#"{
            "id": "chatcmpl-abc",
            "model": "gpt-4o",
            "choices": [{
                "delta": {},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 50
            }
        }"#;

        let parsed: OpenAiStreamChunkBody = serde_json::from_str(chunk_json).unwrap();

        assert_eq!(
            parsed.choices[0].finish_reason.as_deref(),
            Some("stop")
        );
        let usage = parsed.usage.as_ref().unwrap();
        assert_eq!(usage.prompt_tokens, 100);
        assert_eq!(usage.completion_tokens, 50);
    }

    #[test]
    fn test_convert_stream_chunk_to_internal_format_with_content() {
        let provider = OpenAiCompatibleProvider::new("openai", "key", "");

        let chunk = OpenAiStreamChunkBody {
            id: "test-id".to_string(),
            model: "gpt-4o".to_string(),
            choices: vec![OpenAiStreamChoice {
                delta: OpenAiStreamDelta {
                    content: Some("Hello world".to_string()),
                    reasoning: None,
                    reasoning_content: None,
                    tool_calls: None,
                },
                finish_reason: None,
            }],
            usage: None,
            error: None,
        };

        let internal = provider.convert_stream_chunk_to_internal_format(&chunk);

        assert_eq!(internal.id, "test-id");
        assert_eq!(internal.model, "gpt-4o");
        assert_eq!(internal.content_delta, "Hello world");
        assert_eq!(internal.reasoning_delta, "");
        assert!(internal.tool_call_deltas.is_empty());
        assert!(internal.finish_reason.is_none());
        assert!(!internal.done);
    }

    #[test]
    fn test_convert_stream_chunk_to_internal_format_with_reasoning_fallback() {
        let provider = OpenAiCompatibleProvider::new("openrouter", "key", "");

        // When reasoning is None but reasoning_content is set, use reasoning_content.
        let chunk = OpenAiStreamChunkBody {
            id: "test-id".to_string(),
            model: "model".to_string(),
            choices: vec![OpenAiStreamChoice {
                delta: OpenAiStreamDelta {
                    content: None,
                    reasoning: None,
                    reasoning_content: Some("thinking...".to_string()),
                    tool_calls: None,
                },
                finish_reason: None,
            }],
            usage: None,
            error: None,
        };

        let internal = provider.convert_stream_chunk_to_internal_format(&chunk);
        assert_eq!(internal.reasoning_delta, "thinking...");
    }

    #[test]
    fn test_convert_stream_chunk_to_internal_format_done_flag() {
        let provider = OpenAiCompatibleProvider::new("openai", "key", "");

        let chunk = OpenAiStreamChunkBody {
            id: "test-id".to_string(),
            model: "gpt-4o".to_string(),
            choices: vec![OpenAiStreamChoice {
                delta: OpenAiStreamDelta::default(),
                finish_reason: Some("stop".to_string()),
            }],
            usage: Some(OpenAiResponseUsage {
                prompt_tokens: 42,
                completion_tokens: 10,
            }),
            error: None,
        };

        let internal = provider.convert_stream_chunk_to_internal_format(&chunk);

        assert!(internal.done);
        assert_eq!(internal.finish_reason.as_deref(), Some("stop"));
        assert_eq!(internal.prompt_tokens, Some(42));
        assert_eq!(internal.completion_tokens, Some(10));
    }

    #[test]
    fn test_http_error_classification_auth() {
        let provider = OpenAiCompatibleProvider::new("openai", "key", "");
        let error = provider.build_http_error(reqwest::StatusCode::UNAUTHORIZED, "bad key");

        assert_eq!(error.error_type, "auth");
        assert!(!error.is_retryable);
        assert_eq!(error.provider, "openai");
    }

    #[test]
    fn test_http_error_classification_rate_limit() {
        let provider = OpenAiCompatibleProvider::new("openrouter", "key", "");
        let error =
            provider.build_http_error(reqwest::StatusCode::TOO_MANY_REQUESTS, "rate limited");

        assert_eq!(error.error_type, "rate_limit");
        assert!(error.is_retryable);
    }

    #[test]
    fn test_http_error_classification_server_error() {
        let provider = OpenAiCompatibleProvider::new("openai", "key", "");
        let error = provider.build_http_error(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "internal error",
        );

        assert_eq!(error.error_type, "server");
        assert!(error.is_retryable);
    }

    #[test]
    fn test_api_error_retryable_classification() {
        let provider = OpenAiCompatibleProvider::new("openai", "key", "");

        let rate_limit_error = OpenAiResponseError {
            message: "Too many requests".to_string(),
            error_type: "rate_limit_error".to_string(),
        };
        assert!(provider.build_api_error(&rate_limit_error).is_retryable);

        let server_error = OpenAiResponseError {
            message: "Server error".to_string(),
            error_type: "server_error".to_string(),
        };
        assert!(provider.build_api_error(&server_error).is_retryable);

        let invalid_request_error = OpenAiResponseError {
            message: "Bad request".to_string(),
            error_type: "invalid_request_error".to_string(),
        };
        assert!(!provider.build_api_error(&invalid_request_error).is_retryable);
    }

    #[test]
    fn test_convert_response_tool_calls_with_none() {
        let result = OpenAiCompatibleProvider::convert_response_tool_calls(None);
        assert!(result.is_empty());
    }

    #[test]
    fn test_convert_response_tool_calls_with_entries() {
        let tool_calls = vec![
            OpenAiResponseToolCall {
                id: "call_1".to_string(),
                call_type: "function".to_string(),
                function: OpenAiResponseFunction {
                    name: "read_file".to_string(),
                    arguments: r#"{"path":"/tmp/test"}"#.to_string(),
                },
            },
            OpenAiResponseToolCall {
                id: "call_2".to_string(),
                call_type: "function".to_string(),
                function: OpenAiResponseFunction {
                    name: "write_file".to_string(),
                    arguments: r#"{"path":"/tmp/out","content":"hi"}"#.to_string(),
                },
            },
        ];

        let result = OpenAiCompatibleProvider::convert_response_tool_calls(Some(tool_calls));

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "call_1");
        assert_eq!(result[0].function_name, "read_file");
        assert_eq!(result[1].id, "call_2");
        assert_eq!(result[1].function_name, "write_file");
    }

    #[test]
    fn test_truncate_error_body_short_string() {
        let result = truncate_error_body("short", 10);
        assert_eq!(result, "short");
    }

    #[test]
    fn test_truncate_error_body_long_string() {
        let long_string = "a".repeat(100);
        let result = truncate_error_body(&long_string, 10);
        assert_eq!(result.len(), 13); // 10 chars + "..."
        assert!(result.ends_with("..."));
    }

    #[test]
    fn test_streaming_chunk_deserialization_with_empty_delta() {
        // Some providers send chunks with empty deltas.
        let chunk_json = r#"{
            "id": "chatcmpl-abc",
            "model": "gpt-4o",
            "choices": [{
                "delta": {},
                "finish_reason": null
            }]
        }"#;

        let parsed: OpenAiStreamChunkBody = serde_json::from_str(chunk_json).unwrap();

        assert!(parsed.choices[0].delta.content.is_none());
        assert!(parsed.choices[0].delta.reasoning.is_none());
        assert!(parsed.choices[0].delta.tool_calls.is_none());
    }

    #[test]
    fn test_streaming_tool_call_delta_without_function() {
        // Subsequent tool call chunks may omit the function field entirely.
        let chunk_json = r#"{
            "index": 0
        }"#;

        let parsed: OpenAiStreamToolCallDelta = serde_json::from_str(chunk_json).unwrap();

        assert_eq!(parsed.index, 0);
        assert!(parsed.id.is_none());
        assert!(parsed.call_type.is_none());
        assert!(parsed.function.is_none());
    }

    #[test]
    fn test_response_body_deserialization_with_missing_optional_fields() {
        // Minimal response body: just an id and one choice.
        let response_json = r#"{
            "id": "resp-1",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "hi"
                }
            }]
        }"#;

        let parsed: OpenAiResponseBody = serde_json::from_str(response_json).unwrap();

        assert_eq!(parsed.id, "resp-1");
        assert_eq!(parsed.model, ""); // defaulted
        assert!(parsed.usage.is_none());
        assert!(parsed.error.is_none());
        assert!(parsed.choices[0].finish_reason.is_none());
        assert!(parsed.choices[0].message.tool_calls.is_none());
    }
}
