use std::collections::HashMap;
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

/// Default base URL for the Anthropic Messages API.
const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";

/// API version header value required by Anthropic.
const ANTHROPIC_API_VERSION: &str = "2023-06-01";

/// HTTP connection pool idle timeout.
const HTTP_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// HTTP request timeout (generous for long LLM completions).
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

// ===========================================================================
// Anthropic request serialization types
// ===========================================================================

/// Top-level request body sent to the Anthropic Messages API endpoint.
#[derive(Debug, Serialize)]
struct AnthropicRequestBody {
    /// Model identifier (e.g. "claude-sonnet-4-20250514").
    model: String,

    /// Maximum number of tokens to generate.
    max_tokens: i32,

    /// Conversation history in Anthropic message format.
    messages: Vec<AnthropicRequestMessage>,

    /// System prompt text extracted from system-role messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,

    /// Sampling temperature (0.0 - 1.0).
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,

    /// Whether to stream the response via SSE.
    stream: bool,

    /// Tool definitions available for the model to call.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<AnthropicRequestToolDefinition>,
}

/// A single message in the Anthropic message format.
///
/// The `content` field is polymorphic: it can be either a plain string (for
/// simple user/assistant messages) or an array of content blocks (for messages
/// that contain tool use or tool results).
#[derive(Debug, Serialize)]
struct AnthropicRequestMessage {
    /// Role of the message author: "user" or "assistant".
    role: String,

    /// Message content -- either a plain string or an array of content blocks.
    content: AnthropicRequestContent,
}

/// Polymorphic content field for Anthropic messages.
///
/// Serialized as either a JSON string or an array of content blocks using
/// `#[serde(untagged)]`.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnthropicRequestContent {
    /// A plain text string (for simple user/assistant messages).
    Text(String),

    /// An array of content blocks (for tool use, tool results, or mixed content).
    Blocks(Vec<AnthropicRequestContentBlock>),
}

/// A single content block within an Anthropic message.
///
/// Uses `#[serde(untagged)]` so that each variant serializes directly as its
/// inner struct (with the `type` field discriminating them).
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnthropicRequestContentBlock {
    /// A text content block.
    Text(AnthropicRequestTextBlock),

    /// A tool_use content block (assistant requesting a tool call).
    ToolUse(AnthropicRequestToolUseBlock),

    /// A tool_result content block (user providing tool output).
    ToolResult(AnthropicRequestToolResultBlock),
}

/// A text content block in the Anthropic format.
#[derive(Debug, Serialize)]
struct AnthropicRequestTextBlock {
    /// Block type discriminator -- always "text".
    #[serde(rename = "type")]
    block_type: String,

    /// The text content of this block.
    text: String,
}

/// A tool_use content block in the Anthropic format (within assistant messages).
#[derive(Debug, Serialize)]
struct AnthropicRequestToolUseBlock {
    /// Block type discriminator -- always "tool_use".
    #[serde(rename = "type")]
    block_type: String,

    /// Unique identifier for this tool call.
    id: String,

    /// Name of the tool/function to invoke.
    name: String,

    /// Parsed JSON input arguments for the tool.
    input: serde_json::Value,
}

/// A tool_result content block in the Anthropic format (within user messages).
#[derive(Debug, Serialize)]
struct AnthropicRequestToolResultBlock {
    /// Block type discriminator -- always "tool_result".
    #[serde(rename = "type")]
    block_type: String,

    /// Identifier linking this result back to the originating tool_use call.
    tool_use_id: String,

    /// The textual result content from the tool execution.
    content: String,
}

/// A tool definition in the Anthropic format.
#[derive(Debug, Serialize)]
struct AnthropicRequestToolDefinition {
    /// The name of the tool/function.
    name: String,

    /// Human-readable description of what the tool does.
    description: String,

    /// JSON Schema describing the tool's input parameters.
    /// Anthropic uses `input_schema` rather than OpenAI's `parameters`.
    input_schema: serde_json::Value,
}

// ===========================================================================
// Anthropic response deserialization types (non-streaming)
// ===========================================================================

/// Top-level response body from the Anthropic Messages API endpoint.
#[derive(Debug, Deserialize)]
struct AnthropicResponseBody {
    /// Provider-assigned message identifier.
    #[serde(default)]
    id: String,

    /// Response type -- always "message" for successful responses.
    #[serde(default, rename = "type")]
    #[allow(dead_code)]
    response_type: String,

    /// Role -- always "assistant" for completions.
    #[serde(default)]
    #[allow(dead_code)]
    role: String,

    /// The model that produced this response.
    #[serde(default)]
    model: String,

    /// Array of content blocks in the response.
    #[serde(default)]
    content: Vec<AnthropicResponseContentBlock>,

    /// Reason generation stopped: "end_turn", "tool_use", or "max_tokens".
    #[serde(default)]
    stop_reason: Option<String>,

    /// Token usage statistics.
    #[serde(default)]
    usage: Option<AnthropicResponseUsage>,

    /// Error information if the request failed at the API level.
    #[serde(default)]
    error: Option<AnthropicResponseError>,
}

/// A single content block in the Anthropic non-streaming response.
///
/// Uses `#[serde(tag = "type")]` for internally-tagged deserialization based
/// on the `type` field value.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicResponseContentBlock {
    /// A text content block.
    #[serde(rename = "text")]
    Text {
        /// The text content.
        #[serde(default)]
        text: String,
    },

    /// A tool_use content block (the model requesting a tool call).
    #[serde(rename = "tool_use")]
    ToolUse {
        /// Unique identifier for this tool call.
        #[serde(default)]
        id: String,

        /// Name of the tool/function to invoke.
        #[serde(default)]
        name: String,

        /// Parsed JSON input arguments for the tool.
        #[serde(default)]
        input: serde_json::Value,
    },
}

/// Token usage statistics from the Anthropic response.
#[derive(Debug, Default, Deserialize)]
struct AnthropicResponseUsage {
    /// Number of tokens in the prompt (input).
    #[serde(default)]
    input_tokens: i32,

    /// Number of tokens generated in the completion (output).
    #[serde(default)]
    output_tokens: i32,
}

/// Error object returned by the Anthropic API when a request fails.
#[derive(Debug, Default, Deserialize)]
struct AnthropicResponseError {
    /// Human-readable error description.
    #[serde(default)]
    message: String,

    /// Error category (e.g. "invalid_request_error", "rate_limit_error").
    #[serde(default, rename = "type")]
    error_type: String,
}

// ===========================================================================
// Anthropic streaming (SSE) deserialization types
// ===========================================================================

/// A single SSE event from the Anthropic streaming Messages API.
///
/// Anthropic uses `event: {type}\ndata: {json}\n\n` format where the event
/// type determines how the data payload should be interpreted.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicStreamEvent {
    /// The initial event containing the message metadata.
    #[serde(rename = "message_start")]
    MessageStart {
        /// The partial message object with id, model, etc.
        #[serde(default)]
        message: AnthropicStreamMessageStartPayload,
    },

    /// Marks the beginning of a new content block.
    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        /// Zero-based index of this content block.
        #[serde(default)]
        index: usize,

        /// The partial content block with type and (for tool_use) id and name.
        #[serde(default)]
        content_block: AnthropicStreamContentBlockStartPayload,
    },

    /// An incremental delta within a content block.
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta {
        /// Zero-based index of the content block this delta belongs to.
        #[serde(default)]
        index: usize,

        /// The delta payload containing either text or tool input JSON.
        #[serde(default)]
        delta: AnthropicStreamContentDelta,
    },

    /// Marks the end of a content block.
    #[serde(rename = "content_block_stop")]
    ContentBlockStop {
        /// Zero-based index of the content block that ended.
        #[serde(default)]
        #[allow(dead_code)]
        index: usize,
    },

    /// Final message-level delta with stop_reason and usage.
    #[serde(rename = "message_delta")]
    MessageDelta {
        /// The delta payload with stop_reason.
        #[serde(default)]
        delta: AnthropicStreamMessageDeltaPayload,

        /// Token usage for the completion.
        #[serde(default)]
        usage: Option<AnthropicStreamMessageDeltaUsage>,
    },

    /// Marks the end of the entire message stream.
    #[serde(rename = "message_stop")]
    MessageStop,

    /// A ping event used for keep-alive (should be ignored).
    #[serde(rename = "ping")]
    Ping,

    /// An error event emitted mid-stream.
    #[serde(rename = "error")]
    Error {
        /// The error details.
        #[serde(default)]
        error: AnthropicResponseError,
    },
}

/// Payload within a `message_start` SSE event.
#[derive(Debug, Default, Deserialize)]
struct AnthropicStreamMessageStartPayload {
    /// Provider-assigned message identifier.
    #[serde(default)]
    id: String,

    /// The model that is producing this response.
    #[serde(default)]
    model: String,

    /// Token usage for the prompt (input_tokens).
    #[serde(default)]
    usage: Option<AnthropicResponseUsage>,
}

/// Payload within a `content_block_start` SSE event.
///
/// This is polymorphic -- for text blocks only `block_type` is set, while for
/// tool_use blocks `id` and `name` are also populated.
#[derive(Debug, Default, Deserialize)]
struct AnthropicStreamContentBlockStartPayload {
    /// Block type: "text" or "tool_use".
    #[serde(default, rename = "type")]
    block_type: String,

    /// Tool call identifier (only for tool_use blocks).
    #[serde(default)]
    id: Option<String>,

    /// Tool/function name (only for tool_use blocks).
    #[serde(default)]
    name: Option<String>,
}

/// Delta payload within a `content_block_delta` SSE event.
///
/// Uses `#[serde(tag = "type")]` to discriminate between text_delta and
/// input_json_delta variants.
#[derive(Debug, Default, Deserialize)]
#[serde(tag = "type")]
enum AnthropicStreamContentDelta {
    /// An incremental text fragment.
    #[serde(rename = "text_delta")]
    TextDelta {
        /// The text fragment.
        #[serde(default)]
        text: String,
    },

    /// An incremental JSON fragment for a tool_use input.
    #[serde(rename = "input_json_delta")]
    InputJsonDelta {
        /// The partial JSON string.
        #[serde(default)]
        partial_json: String,
    },

    /// Fallback for unknown delta types (should not occur in practice).
    #[default]
    Unknown,
}

/// Delta payload within a `message_delta` SSE event.
#[derive(Debug, Default, Deserialize)]
struct AnthropicStreamMessageDeltaPayload {
    /// Reason generation stopped: "end_turn", "tool_use", or "max_tokens".
    #[serde(default)]
    stop_reason: Option<String>,
}

/// Usage statistics within a `message_delta` SSE event.
#[derive(Debug, Default, Deserialize)]
struct AnthropicStreamMessageDeltaUsage {
    /// Number of tokens generated in the output.
    #[serde(default)]
    output_tokens: i32,
}

/// State tracked across streaming SSE events to accumulate a complete response.
///
/// Anthropic streams content in multiple events, so we need to track partial
/// state for tool calls and metadata across the entire stream.
struct AnthropicStreamAccumulator {
    /// Provider-assigned message identifier from `message_start`.
    message_id: String,

    /// Model identifier from `message_start`.
    message_model: String,

    /// Input tokens from `message_start` usage.
    prompt_tokens: i32,

    /// Output tokens from `message_delta` usage.
    completion_tokens: i32,

    /// Stop reason from `message_delta`.
    stop_reason: Option<String>,

    /// Map from content block index to accumulated tool call metadata.
    /// Populated on `content_block_start` with `type: "tool_use"`.
    tool_call_metadata_by_block_index: HashMap<usize, AnthropicStreamToolCallMetadata>,

    /// Map from content block index to accumulated JSON argument fragments.
    accumulated_tool_input_json_by_block_index: HashMap<usize, String>,
}

/// Metadata for a tool call being accumulated during streaming.
struct AnthropicStreamToolCallMetadata {
    /// Tool call identifier from the content_block_start event.
    tool_call_id: String,

    /// Tool/function name from the content_block_start event.
    tool_name: String,
}

impl AnthropicStreamAccumulator {
    /// Create a new empty stream accumulator.
    fn new() -> Self {
        Self {
            message_id: String::new(),
            message_model: String::new(),
            prompt_tokens: 0,
            completion_tokens: 0,
            stop_reason: None,
            tool_call_metadata_by_block_index: HashMap::new(),
            accumulated_tool_input_json_by_block_index: HashMap::new(),
        }
    }

    /// Build the final list of completed tool calls from accumulated state.
    fn build_completed_tool_calls(&self) -> Vec<LlmToolCall> {
        let mut completed_tool_calls = Vec::new();

        for (block_index, metadata) in &self.tool_call_metadata_by_block_index {
            let accumulated_arguments = self
                .accumulated_tool_input_json_by_block_index
                .get(block_index)
                .cloned()
                .unwrap_or_default();

            completed_tool_calls.push(LlmToolCall {
                id: metadata.tool_call_id.clone(),
                call_type: "function".to_string(),
                function_name: metadata.tool_name.clone(),
                function_arguments: accumulated_arguments,
            });
        }

        // Sort by block index for deterministic ordering.
        completed_tool_calls.sort_by_key(|tool_call| {
            self.tool_call_metadata_by_block_index
                .iter()
                .find(|(_, meta)| meta.tool_call_id == tool_call.id)
                .map(|(idx, _)| *idx)
                .unwrap_or(0)
        });

        completed_tool_calls
    }
}

// ===========================================================================
// Provider implementation
// ===========================================================================

/// An LLM provider that communicates with the Anthropic Messages API.
///
/// This provider handles the unique aspects of Anthropic's API format:
/// system messages extracted to a top-level field, content blocks instead of
/// simple strings, different authentication headers, and a distinct SSE
/// streaming protocol.
pub struct AnthropicProvider {
    /// API key for Anthropic authentication (sent via `x-api-key` header).
    api_key: String,

    /// Base URL for the Messages API endpoint (without trailing slash).
    base_url: String,

    /// Reusable HTTP client with connection pooling.
    http_client: reqwest::Client,
}

impl AnthropicProvider {
    /// Create a new Anthropic provider.
    ///
    /// If `base_url` is empty, the default `https://api.anthropic.com/v1` is
    /// used.
    pub fn new(api_key: &str, base_url: &str) -> Self {
        let resolved_base_url = if base_url.is_empty() {
            ANTHROPIC_DEFAULT_BASE_URL.to_string()
        } else {
            base_url.trim_end_matches('/').to_string()
        };

        let http_client = reqwest::Client::builder()
            .pool_idle_timeout(HTTP_POOL_IDLE_TIMEOUT)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest HTTP client for Anthropic provider");

        Self {
            api_key: api_key.to_string(),
            base_url: resolved_base_url,
            http_client,
        }
    }

    // -----------------------------------------------------------------------
    // Message conversion helpers
    // -----------------------------------------------------------------------

    /// Extract system messages from the conversation and return them as a
    /// single concatenated string (joined with `\n\n`).
    ///
    /// Anthropic requires system messages to be sent in a separate top-level
    /// `system` field rather than inline in the messages array.
    fn extract_system_prompt_from_messages(messages: &[LlmChatMessage]) -> Option<String> {
        let system_message_contents: Vec<&str> = messages
            .iter()
            .filter(|message| message.role == "system")
            .map(|message| message.content.as_str())
            .filter(|content| !content.is_empty())
            .collect();

        if system_message_contents.is_empty() {
            None
        } else {
            Some(system_message_contents.join("\n\n"))
        }
    }

    /// Convert internal chat messages to the Anthropic wire format.
    ///
    /// This method handles several Anthropic-specific requirements:
    /// 1. System messages are removed (they go in the top-level `system` field).
    /// 2. Assistant messages with tool calls use content block arrays.
    /// 3. Tool-role messages are converted to "user" with tool_result blocks.
    /// 4. Consecutive tool_result messages are merged into a single user message.
    fn convert_messages_to_anthropic_format(
        messages: &[LlmChatMessage],
    ) -> Vec<AnthropicRequestMessage> {
        let non_system_messages: Vec<&LlmChatMessage> = messages
            .iter()
            .filter(|message| message.role != "system")
            .collect();

        let mut anthropic_messages: Vec<AnthropicRequestMessage> = Vec::new();

        for message in &non_system_messages {
            if message.role == "tool" {
                // Tool results become "user" messages with tool_result blocks.
                let tool_result_block = AnthropicRequestContentBlock::ToolResult(
                    AnthropicRequestToolResultBlock {
                        block_type: "tool_result".to_string(),
                        tool_use_id: message.tool_call_id.clone(),
                        content: message.content.clone(),
                    },
                );

                // Merge consecutive tool_result blocks into a single user message.
                let should_merge_with_previous = anthropic_messages.last().is_some_and(
                    |previous_message| {
                        previous_message.role == "user"
                            && matches!(
                                &previous_message.content,
                                AnthropicRequestContent::Blocks(blocks)
                                    if blocks.iter().all(|block| matches!(
                                        block,
                                        AnthropicRequestContentBlock::ToolResult(_)
                                    ))
                            )
                    },
                );

                if should_merge_with_previous {
                    // Append to the existing user message's content blocks.
                    if let Some(previous_message) = anthropic_messages.last_mut()
                        && let AnthropicRequestContent::Blocks(ref mut blocks) =
                            previous_message.content
                    {
                        blocks.push(tool_result_block);
                    }
                } else {
                    // Create a new user message with a single tool_result block.
                    anthropic_messages.push(AnthropicRequestMessage {
                        role: "user".to_string(),
                        content: AnthropicRequestContent::Blocks(vec![tool_result_block]),
                    });
                }
            } else if message.role == "assistant" && !message.tool_calls.is_empty() {
                // Assistant messages with tool calls use content block arrays.
                let mut content_blocks: Vec<AnthropicRequestContentBlock> = Vec::new();

                // Add a text block if there is text content.
                if !message.content.is_empty() {
                    content_blocks.push(AnthropicRequestContentBlock::Text(
                        AnthropicRequestTextBlock {
                            block_type: "text".to_string(),
                            text: message.content.clone(),
                        },
                    ));
                }

                // Add tool_use blocks for each tool call.
                for tool_call in &message.tool_calls {
                    // Tool input in Anthropic format is parsed JSON (a Value),
                    // not a JSON-encoded string like OpenAI.
                    let parsed_input: serde_json::Value =
                        serde_json::from_str(&tool_call.function_arguments)
                            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

                    content_blocks.push(AnthropicRequestContentBlock::ToolUse(
                        AnthropicRequestToolUseBlock {
                            block_type: "tool_use".to_string(),
                            id: tool_call.id.clone(),
                            name: tool_call.function_name.clone(),
                            input: parsed_input,
                        },
                    ));
                }

                anthropic_messages.push(AnthropicRequestMessage {
                    role: "assistant".to_string(),
                    content: AnthropicRequestContent::Blocks(content_blocks),
                });
            } else {
                // Simple user or assistant message with plain text content.
                anthropic_messages.push(AnthropicRequestMessage {
                    role: message.role.clone(),
                    content: AnthropicRequestContent::Text(message.content.clone()),
                });
            }
        }

        anthropic_messages
    }

    /// Convert internal tool definitions to the Anthropic wire format.
    fn convert_tools_to_anthropic_format(
        tools: &[LlmToolDefinition],
    ) -> Vec<AnthropicRequestToolDefinition> {
        tools
            .iter()
            .map(|tool| AnthropicRequestToolDefinition {
                name: tool.name.clone(),
                description: tool.description.clone(),
                input_schema: tool.parameters_schema.clone(),
            })
            .collect()
    }

    /// Build the JSON request body for a completion call.
    fn build_request_body(
        &self,
        request: &LlmCompletionRequest,
        stream: bool,
    ) -> AnthropicRequestBody {
        let system_prompt = Self::extract_system_prompt_from_messages(&request.messages);

        AnthropicRequestBody {
            model: request.model.clone(),
            max_tokens: request.max_tokens.unwrap_or(4096),
            messages: Self::convert_messages_to_anthropic_format(&request.messages),
            system: system_prompt,
            temperature: request.temperature,
            stream,
            tools: Self::convert_tools_to_anthropic_format(&request.tools),
        }
    }

    /// Construct the Messages API endpoint URL.
    fn messages_endpoint_url(&self) -> String {
        format!("{}/messages", self.base_url)
    }

    // -----------------------------------------------------------------------
    // Error construction helpers
    // -----------------------------------------------------------------------

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
                "anthropic returned HTTP {}: {}",
                status.as_u16(),
                truncate_error_body(body, 500),
            ),
            error_type,
            provider: "anthropic".to_string(),
            is_retryable,
        }
    }

    /// Create an `LlmProviderError` from an API-level error object.
    fn build_api_error(&self, error: &AnthropicResponseError) -> LlmProviderError {
        let is_retryable = error.error_type == "rate_limit_error"
            || error.error_type == "api_error"
            || error.error_type == "overloaded_error";

        LlmProviderError {
            message: format!(
                "anthropic API error: {} (type={})",
                error.message, error.error_type,
            ),
            error_type: error.error_type.clone(),
            provider: "anthropic".to_string(),
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
            message: format!("anthropic transport error: {}", error),
            error_type,
            provider: "anthropic".to_string(),
            is_retryable,
        }
    }

    // -----------------------------------------------------------------------
    // Response conversion helpers
    // -----------------------------------------------------------------------

    /// Map Anthropic stop reasons to the canonical Kraken stop reason strings.
    ///
    /// Anthropic uses different stop reason values from OpenAI:
    /// - `end_turn` -> `stop`
    /// - `tool_use` -> `tool_calls`
    /// - `max_tokens` -> `length`
    fn map_stop_reason_to_canonical_format(anthropic_stop_reason: &str) -> String {
        match anthropic_stop_reason {
            "end_turn" => "stop".to_string(),
            "tool_use" => "tool_calls".to_string(),
            "max_tokens" => "length".to_string(),
            other => other.to_string(),
        }
    }

    /// Extract text content from a response content block array.
    fn extract_text_content_from_response_blocks(
        blocks: &[AnthropicResponseContentBlock],
    ) -> String {
        blocks
            .iter()
            .filter_map(|block| match block {
                AnthropicResponseContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<&str>>()
            .join("")
    }

    /// Extract tool calls from a response content block array.
    fn extract_tool_calls_from_response_blocks(
        blocks: &[AnthropicResponseContentBlock],
    ) -> Vec<LlmToolCall> {
        blocks
            .iter()
            .filter_map(|block| match block {
                AnthropicResponseContentBlock::ToolUse { id, name, input } => {
                    Some(LlmToolCall {
                        id: id.clone(),
                        call_type: "function".to_string(),
                        function_name: name.clone(),
                        // Anthropic sends parsed JSON; we serialize it back to a
                        // string to match the canonical Kraken LlmToolCall format.
                        function_arguments: serde_json::to_string(input)
                            .unwrap_or_default(),
                    })
                }
                _ => None,
            })
            .collect()
    }

    // -----------------------------------------------------------------------
    // Streaming helpers
    // -----------------------------------------------------------------------

    /// Process a single SSE event from the Anthropic stream and optionally
    /// produce an `LlmStreamChunk` to deliver to the callback.
    ///
    /// Returns `Ok(Some(chunk))` when the event produces a deliverable chunk,
    /// `Ok(None)` when the event only updates internal accumulator state, or
    /// `Err` when an error event is encountered.
    fn process_stream_event(
        &self,
        event: &AnthropicStreamEvent,
        accumulator: &mut AnthropicStreamAccumulator,
    ) -> Result<Option<LlmStreamChunk>, LlmProviderError> {
        match event {
            AnthropicStreamEvent::MessageStart { message } => {
                accumulator.message_id = message.id.clone();
                accumulator.message_model = message.model.clone();
                if let Some(ref usage) = message.usage {
                    accumulator.prompt_tokens = usage.input_tokens;
                }
                Ok(None)
            }

            AnthropicStreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                if content_block.block_type == "tool_use" {
                    accumulator.tool_call_metadata_by_block_index.insert(
                        *index,
                        AnthropicStreamToolCallMetadata {
                            tool_call_id: content_block.id.clone().unwrap_or_default(),
                            tool_name: content_block.name.clone().unwrap_or_default(),
                        },
                    );
                    accumulator
                        .accumulated_tool_input_json_by_block_index
                        .insert(*index, String::new());
                }
                Ok(None)
            }

            AnthropicStreamEvent::ContentBlockDelta { index, delta } => match delta {
                AnthropicStreamContentDelta::TextDelta { text } => {
                    Ok(Some(LlmStreamChunk {
                        id: accumulator.message_id.clone(),
                        model: accumulator.message_model.clone(),
                        content_delta: text.clone(),
                        reasoning_delta: String::new(),
                        tool_call_deltas: Vec::new(),
                        finish_reason: None,
                        prompt_tokens: None,
                        completion_tokens: None,
                        done: false,
                    }))
                }
                AnthropicStreamContentDelta::InputJsonDelta { partial_json } => {
                    // Accumulate the JSON fragment.
                    accumulator
                        .accumulated_tool_input_json_by_block_index
                        .entry(*index)
                        .or_default()
                        .push_str(partial_json);

                    // Look up the tool metadata to get the id and name.
                    let metadata = accumulator
                        .tool_call_metadata_by_block_index
                        .get(index);

                    let tool_call_delta = LlmToolCallDelta {
                        index: *index as i32,
                        id: metadata
                            .map(|m| m.tool_call_id.clone())
                            .unwrap_or_default(),
                        call_type: "function".to_string(),
                        function_name: metadata
                            .map(|m| m.tool_name.clone())
                            .unwrap_or_default(),
                        function_arguments_delta: partial_json.clone(),
                    };

                    Ok(Some(LlmStreamChunk {
                        id: accumulator.message_id.clone(),
                        model: accumulator.message_model.clone(),
                        content_delta: String::new(),
                        reasoning_delta: String::new(),
                        tool_call_deltas: vec![tool_call_delta],
                        finish_reason: None,
                        prompt_tokens: None,
                        completion_tokens: None,
                        done: false,
                    }))
                }
                AnthropicStreamContentDelta::Unknown => Ok(None),
            },

            AnthropicStreamEvent::ContentBlockStop { .. } => Ok(None),

            AnthropicStreamEvent::MessageDelta { delta, usage } => {
                if let Some(ref stop_reason) = delta.stop_reason {
                    accumulator.stop_reason =
                        Some(Self::map_stop_reason_to_canonical_format(stop_reason));
                }
                if let Some(usage_data) = usage {
                    accumulator.completion_tokens = usage_data.output_tokens;
                }
                Ok(None)
            }

            AnthropicStreamEvent::MessageStop => {
                // Build the final done chunk with accumulated tool calls.
                let completed_tool_calls = accumulator.build_completed_tool_calls();
                let tool_call_deltas: Vec<LlmToolCallDelta> = completed_tool_calls
                    .iter()
                    .enumerate()
                    .map(|(index, tool_call)| LlmToolCallDelta {
                        index: index as i32,
                        id: tool_call.id.clone(),
                        call_type: "function".to_string(),
                        function_name: tool_call.function_name.clone(),
                        function_arguments_delta: String::new(),
                    })
                    .collect();

                Ok(Some(LlmStreamChunk {
                    id: accumulator.message_id.clone(),
                    model: accumulator.message_model.clone(),
                    content_delta: String::new(),
                    reasoning_delta: String::new(),
                    tool_call_deltas,
                    finish_reason: accumulator.stop_reason.clone(),
                    prompt_tokens: Some(accumulator.prompt_tokens),
                    completion_tokens: Some(accumulator.completion_tokens),
                    done: true,
                }))
            }

            AnthropicStreamEvent::Ping => Ok(None),

            AnthropicStreamEvent::Error { error } => Err(self.build_api_error(error)),
        }
    }
}

// ---------------------------------------------------------------------------
// LlmProvider trait implementation
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
impl LlmProvider for AnthropicProvider {
    /// Perform a non-streaming completion request against the Anthropic Messages API.
    async fn complete(
        &self,
        request: LlmCompletionRequest,
    ) -> Result<LlmCompletionResponse, LlmProviderError> {
        let request_body = self.build_request_body(&request, false);

        let serialized_body =
            serde_json::to_string(&request_body).map_err(|serialization_error| {
                LlmProviderError {
                    message: format!(
                        "failed to serialize Anthropic request body: {serialization_error}"
                    ),
                    error_type: "serialization".to_string(),
                    provider: "anthropic".to_string(),
                    is_retryable: false,
                }
            })?;

        let http_response = self
            .http_client
            .post(self.messages_endpoint_url())
            .header("Content-Type", "application/json")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_API_VERSION)
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

        let parsed_response: AnthropicResponseBody =
            serde_json::from_str(&response_body_text).map_err(|parse_error| LlmProviderError {
                message: format!(
                    "failed to parse Anthropic response JSON: {parse_error} (body: {})",
                    truncate_error_body(&response_body_text, 500),
                ),
                error_type: "deserialization".to_string(),
                provider: "anthropic".to_string(),
                is_retryable: false,
            })?;

        // Check for API-level error in the response body.
        if let Some(ref api_error) = parsed_response.error {
            return Err(self.build_api_error(api_error));
        }

        let usage = parsed_response.usage.unwrap_or_default();

        let finish_reason = parsed_response
            .stop_reason
            .as_deref()
            .map(Self::map_stop_reason_to_canonical_format)
            .unwrap_or_default();

        Ok(LlmCompletionResponse {
            id: parsed_response.id,
            model: parsed_response.model,
            content: Self::extract_text_content_from_response_blocks(&parsed_response.content),
            tool_calls: Self::extract_tool_calls_from_response_blocks(&parsed_response.content),
            finish_reason,
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
        })
    }

    /// Perform a streaming completion request, calling `callback` for each SSE event.
    ///
    /// Anthropic uses `event: {type}\ndata: {json}\n\n` format, which differs
    /// from OpenAI's `data: {json}` only format.
    async fn stream_complete(
        &self,
        request: LlmCompletionRequest,
        callback: Box<dyn Fn(LlmStreamChunk) -> Result<(), String> + Send>,
    ) -> Result<(), LlmProviderError> {
        let request_body = self.build_request_body(&request, true);

        let serialized_body =
            serde_json::to_string(&request_body).map_err(|serialization_error| {
                LlmProviderError {
                    message: format!(
                        "failed to serialize Anthropic request body: {serialization_error}"
                    ),
                    error_type: "serialization".to_string(),
                    provider: "anthropic".to_string(),
                    is_retryable: false,
                }
            })?;

        let http_response = self
            .http_client
            .post(self.messages_endpoint_url())
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_API_VERSION)
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
        let mut chunks_delivered: u64 = 0;
        let mut received_message_stop = false;
        let mut accumulator = AnthropicStreamAccumulator::new();

        // Track the current SSE event type (from the `event:` line).
        let mut current_event_type: Option<String> = None;

        while let Some(chunk_result) = byte_stream.next().await {
            let chunk_bytes = chunk_result.map_err(|stream_error| LlmProviderError {
                message: format!(
                    "anthropic stream read error after {chunks_delivered} chunks: {stream_error}",
                ),
                error_type: "stream".to_string(),
                provider: "anthropic".to_string(),
                is_retryable: true,
            })?;

            // Append raw bytes to the line buffer. SSE is always UTF-8.
            let chunk_text = String::from_utf8_lossy(&chunk_bytes);
            line_buffer.push_str(&chunk_text);

            // Process complete lines from the buffer.
            while let Some(newline_position) = line_buffer.find('\n') {
                let line = line_buffer[..newline_position]
                    .trim_end_matches('\r')
                    .to_string();
                line_buffer = line_buffer[newline_position + 1..].to_string();

                // Skip empty lines (SSE event separators).
                if line.is_empty() {
                    current_event_type = None;
                    continue;
                }

                // Capture the event type from `event: {type}` lines.
                if let Some(event_type_value) = line.strip_prefix("event: ") {
                    current_event_type = Some(event_type_value.trim().to_string());
                    continue;
                }

                // Process `data: {json}` lines.
                let Some(data_payload) = line.strip_prefix("data: ") else {
                    continue;
                };

                let data_payload = data_payload.trim();

                // Parse the JSON event payload. Anthropic events always have a
                // `type` field, but we may need the event type from the SSE
                // `event:` line as fallback context.
                let parsed_event: AnthropicStreamEvent = match serde_json::from_str(data_payload) {
                    Ok(event) => event,
                    Err(parse_error) => {
                        tracing::warn!(
                            provider = "anthropic",
                            event_type = ?current_event_type,
                            error = %parse_error,
                            data = %truncate_error_body(data_payload, 200),
                            "skipping malformed Anthropic SSE event",
                        );
                        continue;
                    }
                };

                // Process the event and optionally emit a chunk.
                match self.process_stream_event(&parsed_event, &mut accumulator) {
                    Ok(Some(internal_chunk)) => {
                        if internal_chunk.done {
                            received_message_stop = true;
                        }

                        chunks_delivered += 1;

                        callback(internal_chunk).map_err(|callback_error| LlmProviderError {
                            message: format!("stream callback returned error: {callback_error}"),
                            error_type: "callback".to_string(),
                            provider: "anthropic".to_string(),
                            is_retryable: false,
                        })?;
                    }
                    Ok(None) => {
                        // Event only updated internal state, no chunk to deliver.
                    }
                    Err(stream_error) => {
                        return Err(stream_error);
                    }
                }
            }

            if received_message_stop {
                break;
            }
        }

        if !received_message_stop && chunks_delivered == 0 {
            return Err(LlmProviderError {
                message:
                    "anthropic stream ended without data (no chunks delivered, no message_stop event)"
                        .to_string(),
                error_type: "empty_stream".to_string(),
                provider: "anthropic".to_string(),
                is_retryable: true,
            });
        }

        Ok(())
    }

    /// Return the canonical name of this provider.
    fn provider_name(&self) -> &str {
        "anthropic"
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

    // -----------------------------------------------------------------------
    // Provider construction tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_provider_creation_with_default_base_url() {
        let provider = AnthropicProvider::new("sk-ant-test", "");
        assert_eq!(provider.provider_name(), "anthropic");
        assert_eq!(provider.base_url, ANTHROPIC_DEFAULT_BASE_URL);
        assert_eq!(provider.api_key, "sk-ant-test");
    }

    #[test]
    fn test_provider_creation_with_custom_base_url() {
        let provider = AnthropicProvider::new("key", "https://custom.anthropic.com/v1/");
        assert_eq!(provider.base_url, "https://custom.anthropic.com/v1");
    }

    #[test]
    fn test_messages_endpoint_url_construction() {
        let provider = AnthropicProvider::new("key", "https://api.anthropic.com/v1");
        assert_eq!(
            provider.messages_endpoint_url(),
            "https://api.anthropic.com/v1/messages"
        );
    }

    // -----------------------------------------------------------------------
    // System prompt extraction tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_extract_system_prompt_from_messages_single_system() {
        let messages = vec![
            LlmChatMessage {
                role: "system".to_string(),
                content: "You are a helpful assistant".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
            LlmChatMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
        ];

        let system = AnthropicProvider::extract_system_prompt_from_messages(&messages);
        assert_eq!(system.as_deref(), Some("You are a helpful assistant"));
    }

    #[test]
    fn test_extract_system_prompt_from_messages_multiple_system() {
        let messages = vec![
            LlmChatMessage {
                role: "system".to_string(),
                content: "You are helpful".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
            LlmChatMessage {
                role: "system".to_string(),
                content: "Be concise".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
        ];

        let system = AnthropicProvider::extract_system_prompt_from_messages(&messages);
        assert_eq!(system.as_deref(), Some("You are helpful\n\nBe concise"));
    }

    #[test]
    fn test_extract_system_prompt_from_messages_no_system() {
        let messages = vec![LlmChatMessage {
            role: "user".to_string(),
            content: "Hello".to_string(),
            tool_calls: vec![],
            tool_call_id: String::new(),
            name: String::new(),
        }];

        let system = AnthropicProvider::extract_system_prompt_from_messages(&messages);
        assert!(system.is_none());
    }

    #[test]
    fn test_extract_system_prompt_from_messages_empty_system_content() {
        let messages = vec![LlmChatMessage {
            role: "system".to_string(),
            content: String::new(),
            tool_calls: vec![],
            tool_call_id: String::new(),
            name: String::new(),
        }];

        let system = AnthropicProvider::extract_system_prompt_from_messages(&messages);
        assert!(system.is_none());
    }

    // -----------------------------------------------------------------------
    // Message conversion tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_message_conversion_simple_user_message() {
        let messages = vec![LlmChatMessage {
            role: "user".to_string(),
            content: "Hello".to_string(),
            tool_calls: vec![],
            tool_call_id: String::new(),
            name: String::new(),
        }];

        let converted = AnthropicProvider::convert_messages_to_anthropic_format(&messages);

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].role, "user");
        match &converted[0].content {
            AnthropicRequestContent::Text(text) => assert_eq!(text, "Hello"),
            _ => panic!("expected Text content for simple user message"),
        }
    }

    #[test]
    fn test_message_conversion_filters_out_system_messages() {
        let messages = vec![
            LlmChatMessage {
                role: "system".to_string(),
                content: "System prompt".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
            LlmChatMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
        ];

        let converted = AnthropicProvider::convert_messages_to_anthropic_format(&messages);

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].role, "user");
    }

    #[test]
    fn test_message_conversion_assistant_with_tool_calls() {
        let messages = vec![LlmChatMessage {
            role: "assistant".to_string(),
            content: "Let me check...".to_string(),
            tool_calls: vec![LlmToolCall {
                id: "call_1".to_string(),
                call_type: "function".to_string(),
                function_name: "get_weather".to_string(),
                function_arguments: r#"{"city":"SF"}"#.to_string(),
            }],
            tool_call_id: String::new(),
            name: String::new(),
        }];

        let converted = AnthropicProvider::convert_messages_to_anthropic_format(&messages);

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].role, "assistant");

        match &converted[0].content {
            AnthropicRequestContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                // First block should be text.
                match &blocks[0] {
                    AnthropicRequestContentBlock::Text(text_block) => {
                        assert_eq!(text_block.block_type, "text");
                        assert_eq!(text_block.text, "Let me check...");
                    }
                    _ => panic!("expected Text block as first content block"),
                }
                // Second block should be tool_use.
                match &blocks[1] {
                    AnthropicRequestContentBlock::ToolUse(tool_use_block) => {
                        assert_eq!(tool_use_block.block_type, "tool_use");
                        assert_eq!(tool_use_block.id, "call_1");
                        assert_eq!(tool_use_block.name, "get_weather");
                        assert_eq!(tool_use_block.input, serde_json::json!({"city": "SF"}));
                    }
                    _ => panic!("expected ToolUse block as second content block"),
                }
            }
            _ => panic!("expected Blocks content for assistant with tool calls"),
        }
    }

    #[test]
    fn test_message_conversion_assistant_with_tool_calls_no_text() {
        let messages = vec![LlmChatMessage {
            role: "assistant".to_string(),
            content: String::new(),
            tool_calls: vec![LlmToolCall {
                id: "call_1".to_string(),
                call_type: "function".to_string(),
                function_name: "read_file".to_string(),
                function_arguments: r#"{"path":"/tmp/test"}"#.to_string(),
            }],
            tool_call_id: String::new(),
            name: String::new(),
        }];

        let converted = AnthropicProvider::convert_messages_to_anthropic_format(&messages);

        match &converted[0].content {
            AnthropicRequestContent::Blocks(blocks) => {
                // Should have only the tool_use block, no empty text block.
                assert_eq!(blocks.len(), 1);
                match &blocks[0] {
                    AnthropicRequestContentBlock::ToolUse(tool_use_block) => {
                        assert_eq!(tool_use_block.name, "read_file");
                    }
                    _ => panic!("expected ToolUse block"),
                }
            }
            _ => panic!("expected Blocks content"),
        }
    }

    #[test]
    fn test_message_conversion_tool_result_becomes_user_message() {
        let messages = vec![LlmChatMessage {
            role: "tool".to_string(),
            content: "72F sunny".to_string(),
            tool_calls: vec![],
            tool_call_id: "call_1".to_string(),
            name: "get_weather".to_string(),
        }];

        let converted = AnthropicProvider::convert_messages_to_anthropic_format(&messages);

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].role, "user");

        match &converted[0].content {
            AnthropicRequestContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 1);
                match &blocks[0] {
                    AnthropicRequestContentBlock::ToolResult(result_block) => {
                        assert_eq!(result_block.block_type, "tool_result");
                        assert_eq!(result_block.tool_use_id, "call_1");
                        assert_eq!(result_block.content, "72F sunny");
                    }
                    _ => panic!("expected ToolResult block"),
                }
            }
            _ => panic!("expected Blocks content for tool result"),
        }
    }

    #[test]
    fn test_message_conversion_consecutive_tool_results_merged() {
        let messages = vec![
            LlmChatMessage {
                role: "tool".to_string(),
                content: "72F sunny".to_string(),
                tool_calls: vec![],
                tool_call_id: "call_1".to_string(),
                name: "get_weather".to_string(),
            },
            LlmChatMessage {
                role: "tool".to_string(),
                content: "Population: 800k".to_string(),
                tool_calls: vec![],
                tool_call_id: "call_2".to_string(),
                name: "get_population".to_string(),
            },
        ];

        let converted = AnthropicProvider::convert_messages_to_anthropic_format(&messages);

        // Should be merged into a single user message.
        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].role, "user");

        match &converted[0].content {
            AnthropicRequestContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                match &blocks[0] {
                    AnthropicRequestContentBlock::ToolResult(result_block) => {
                        assert_eq!(result_block.tool_use_id, "call_1");
                    }
                    _ => panic!("expected ToolResult block at index 0"),
                }
                match &blocks[1] {
                    AnthropicRequestContentBlock::ToolResult(result_block) => {
                        assert_eq!(result_block.tool_use_id, "call_2");
                    }
                    _ => panic!("expected ToolResult block at index 1"),
                }
            }
            _ => panic!("expected Blocks content"),
        }
    }

    #[test]
    fn test_message_conversion_tool_results_not_merged_when_interrupted() {
        let messages = vec![
            LlmChatMessage {
                role: "tool".to_string(),
                content: "result 1".to_string(),
                tool_calls: vec![],
                tool_call_id: "call_1".to_string(),
                name: "tool_1".to_string(),
            },
            LlmChatMessage {
                role: "user".to_string(),
                content: "What happened?".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
            LlmChatMessage {
                role: "tool".to_string(),
                content: "result 2".to_string(),
                tool_calls: vec![],
                tool_call_id: "call_2".to_string(),
                name: "tool_2".to_string(),
            },
        ];

        let converted = AnthropicProvider::convert_messages_to_anthropic_format(&messages);

        // Should have three separate messages (no merging across the user message).
        assert_eq!(converted.len(), 3);
        assert_eq!(converted[0].role, "user"); // first tool result
        assert_eq!(converted[1].role, "user"); // user message
        assert_eq!(converted[2].role, "user"); // second tool result
    }

    // -----------------------------------------------------------------------
    // Tool definition conversion tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_tool_definition_conversion_to_anthropic_format() {
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

        let converted = AnthropicProvider::convert_tools_to_anthropic_format(&tools);

        assert_eq!(converted.len(), 1);
        assert_eq!(converted[0].name, "read_file");
        assert_eq!(converted[0].description, "Read a file from disk");
        assert_eq!(
            converted[0].input_schema,
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                }
            })
        );
    }

    // -----------------------------------------------------------------------
    // Request body construction tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_request_body_extracts_system_prompt() {
        let provider = AnthropicProvider::new("key", "");
        let request = LlmCompletionRequest {
            model: "claude-sonnet-4-20250514".to_string(),
            messages: vec![
                LlmChatMessage {
                    role: "system".to_string(),
                    content: "You are helpful".to_string(),
                    tool_calls: vec![],
                    tool_call_id: String::new(),
                    name: String::new(),
                },
                LlmChatMessage {
                    role: "user".to_string(),
                    content: "Hello".to_string(),
                    tool_calls: vec![],
                    tool_call_id: String::new(),
                    name: String::new(),
                },
            ],
            temperature: Some(0.7),
            max_tokens: Some(2048),
            tools: vec![],
            include_reasoning: false,
            provider: "anthropic".to_string(),
        };

        let body = provider.build_request_body(&request, false);

        assert_eq!(body.model, "claude-sonnet-4-20250514");
        assert_eq!(body.system.as_deref(), Some("You are helpful"));
        assert_eq!(body.temperature, Some(0.7));
        assert_eq!(body.max_tokens, 2048);
        assert!(!body.stream);
        // System message should not be in the messages array.
        assert_eq!(body.messages.len(), 1);
        assert_eq!(body.messages[0].role, "user");
    }

    #[test]
    fn test_request_body_defaults_max_tokens_to_4096() {
        let provider = AnthropicProvider::new("key", "");
        let request = LlmCompletionRequest {
            model: "claude-sonnet-4-20250514".to_string(),
            messages: vec![],
            temperature: None,
            max_tokens: None,
            tools: vec![],
            include_reasoning: false,
            provider: "anthropic".to_string(),
        };

        let body = provider.build_request_body(&request, false);
        assert_eq!(body.max_tokens, 4096);
    }

    #[test]
    fn test_request_body_serialization_omits_none_and_empty_fields() {
        let provider = AnthropicProvider::new("key", "");
        let request = LlmCompletionRequest {
            model: "claude-sonnet-4-20250514".to_string(),
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
            provider: "anthropic".to_string(),
        };

        let body = provider.build_request_body(&request, false);
        let json_string = serde_json::to_string(&body).unwrap();

        assert!(!json_string.contains("\"temperature\""));
        assert!(!json_string.contains("\"tools\""));
        assert!(!json_string.contains("\"system\""));
        assert!(json_string.contains("\"model\":\"claude-sonnet-4-20250514\""));
        assert!(json_string.contains("\"stream\":false"));
        assert!(json_string.contains("\"max_tokens\":4096"));
    }

    // -----------------------------------------------------------------------
    // Stop reason mapping tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_stop_reason_mapping_end_turn_to_stop() {
        assert_eq!(
            AnthropicProvider::map_stop_reason_to_canonical_format("end_turn"),
            "stop"
        );
    }

    #[test]
    fn test_stop_reason_mapping_tool_use_to_tool_calls() {
        assert_eq!(
            AnthropicProvider::map_stop_reason_to_canonical_format("tool_use"),
            "tool_calls"
        );
    }

    #[test]
    fn test_stop_reason_mapping_max_tokens_to_length() {
        assert_eq!(
            AnthropicProvider::map_stop_reason_to_canonical_format("max_tokens"),
            "length"
        );
    }

    #[test]
    fn test_stop_reason_mapping_unknown_passes_through() {
        assert_eq!(
            AnthropicProvider::map_stop_reason_to_canonical_format("something_new"),
            "something_new"
        );
    }

    // -----------------------------------------------------------------------
    // Non-streaming response deserialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_non_streaming_response_deserialization_with_text() {
        let response_json = r#"{
            "id": "msg_123",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-20250514",
            "content": [
                {"type": "text", "text": "Here's the weather..."}
            ],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 100, "output_tokens": 50}
        }"#;

        let parsed: AnthropicResponseBody = serde_json::from_str(response_json).unwrap();

        assert_eq!(parsed.id, "msg_123");
        assert_eq!(parsed.model, "claude-sonnet-4-20250514");
        assert_eq!(parsed.content.len(), 1);

        let text = AnthropicProvider::extract_text_content_from_response_blocks(&parsed.content);
        assert_eq!(text, "Here's the weather...");

        assert_eq!(parsed.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(parsed.usage.as_ref().unwrap().input_tokens, 100);
        assert_eq!(parsed.usage.as_ref().unwrap().output_tokens, 50);
    }

    #[test]
    fn test_non_streaming_response_deserialization_with_tool_use() {
        let response_json = r#"{
            "id": "msg_456",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-20250514",
            "content": [
                {"type": "text", "text": "Let me check the weather."},
                {"type": "tool_use", "id": "call_1", "name": "get_weather", "input": {"city": "SF"}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 80, "output_tokens": 30}
        }"#;

        let parsed: AnthropicResponseBody = serde_json::from_str(response_json).unwrap();

        assert_eq!(parsed.content.len(), 2);

        let text = AnthropicProvider::extract_text_content_from_response_blocks(&parsed.content);
        assert_eq!(text, "Let me check the weather.");

        let tool_calls =
            AnthropicProvider::extract_tool_calls_from_response_blocks(&parsed.content);
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_1");
        assert_eq!(tool_calls[0].function_name, "get_weather");
        assert_eq!(tool_calls[0].function_arguments, r#"{"city":"SF"}"#);
    }

    #[test]
    fn test_non_streaming_response_with_error() {
        let response_json = r#"{
            "type": "error",
            "error": {
                "type": "rate_limit_error",
                "message": "Rate limit exceeded"
            }
        }"#;

        let parsed: AnthropicResponseBody = serde_json::from_str(response_json).unwrap();
        let error = parsed.error.as_ref().unwrap();

        assert_eq!(error.message, "Rate limit exceeded");
        assert_eq!(error.error_type, "rate_limit_error");
    }

    // -----------------------------------------------------------------------
    // Streaming event deserialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_stream_event_message_start_deserialization() {
        let event_json = r#"{
            "type": "message_start",
            "message": {
                "id": "msg_123",
                "model": "claude-sonnet-4-20250514",
                "usage": {"input_tokens": 42, "output_tokens": 0}
            }
        }"#;

        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::MessageStart { message } => {
                assert_eq!(message.id, "msg_123");
                assert_eq!(message.model, "claude-sonnet-4-20250514");
                assert_eq!(message.usage.as_ref().unwrap().input_tokens, 42);
            }
            _ => panic!("expected MessageStart event"),
        }
    }

    #[test]
    fn test_stream_event_content_block_start_text_deserialization() {
        let event_json = r#"{
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""}
        }"#;

        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                assert_eq!(index, 0);
                assert_eq!(content_block.block_type, "text");
                assert!(content_block.id.is_none());
                assert!(content_block.name.is_none());
            }
            _ => panic!("expected ContentBlockStart event"),
        }
    }

    #[test]
    fn test_stream_event_content_block_start_tool_use_deserialization() {
        let event_json = r#"{
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "tool_use", "id": "call_1", "name": "get_weather"}
        }"#;

        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                assert_eq!(index, 1);
                assert_eq!(content_block.block_type, "tool_use");
                assert_eq!(content_block.id.as_deref(), Some("call_1"));
                assert_eq!(content_block.name.as_deref(), Some("get_weather"));
            }
            _ => panic!("expected ContentBlockStart event"),
        }
    }

    #[test]
    fn test_stream_event_content_block_delta_text_deserialization() {
        let event_json = r#"{
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "Hello"}
        }"#;

        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::ContentBlockDelta { index, delta } => {
                assert_eq!(index, 0);
                match delta {
                    AnthropicStreamContentDelta::TextDelta { text } => {
                        assert_eq!(text, "Hello");
                    }
                    _ => panic!("expected TextDelta"),
                }
            }
            _ => panic!("expected ContentBlockDelta event"),
        }
    }

    #[test]
    fn test_stream_event_content_block_delta_input_json_deserialization() {
        let event_json = r#"{
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": "{\"city\""}
        }"#;

        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::ContentBlockDelta { index, delta } => {
                assert_eq!(index, 1);
                match delta {
                    AnthropicStreamContentDelta::InputJsonDelta { partial_json } => {
                        assert_eq!(partial_json, "{\"city\"");
                    }
                    _ => panic!("expected InputJsonDelta"),
                }
            }
            _ => panic!("expected ContentBlockDelta event"),
        }
    }

    #[test]
    fn test_stream_event_message_delta_deserialization() {
        let event_json = r#"{
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 50}
        }"#;

        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::MessageDelta { delta, usage } => {
                assert_eq!(delta.stop_reason.as_deref(), Some("end_turn"));
                assert_eq!(usage.as_ref().unwrap().output_tokens, 50);
            }
            _ => panic!("expected MessageDelta event"),
        }
    }

    #[test]
    fn test_stream_event_message_stop_deserialization() {
        let event_json = r#"{"type": "message_stop"}"#;
        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::MessageStop => {}
            _ => panic!("expected MessageStop event"),
        }
    }

    #[test]
    fn test_stream_event_ping_deserialization() {
        let event_json = r#"{"type": "ping"}"#;
        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::Ping => {}
            _ => panic!("expected Ping event"),
        }
    }

    #[test]
    fn test_stream_event_error_deserialization() {
        let event_json = r#"{
            "type": "error",
            "error": {
                "type": "overloaded_error",
                "message": "Overloaded"
            }
        }"#;

        let parsed: AnthropicStreamEvent = serde_json::from_str(event_json).unwrap();

        match parsed {
            AnthropicStreamEvent::Error { error } => {
                assert_eq!(error.error_type, "overloaded_error");
                assert_eq!(error.message, "Overloaded");
            }
            _ => panic!("expected Error event"),
        }
    }

    // -----------------------------------------------------------------------
    // Stream event processing tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_process_message_start_event_updates_accumulator() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();

        let event = AnthropicStreamEvent::MessageStart {
            message: AnthropicStreamMessageStartPayload {
                id: "msg_abc".to_string(),
                model: "claude-sonnet-4-20250514".to_string(),
                usage: Some(AnthropicResponseUsage {
                    input_tokens: 100,
                    output_tokens: 0,
                }),
            },
        };

        let result = provider.process_stream_event(&event, &mut accumulator);
        assert!(result.unwrap().is_none());
        assert_eq!(accumulator.message_id, "msg_abc");
        assert_eq!(accumulator.message_model, "claude-sonnet-4-20250514");
        assert_eq!(accumulator.prompt_tokens, 100);
    }

    #[test]
    fn test_process_content_block_start_tool_use_registers_metadata() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();

        let event = AnthropicStreamEvent::ContentBlockStart {
            index: 1,
            content_block: AnthropicStreamContentBlockStartPayload {
                block_type: "tool_use".to_string(),
                id: Some("call_xyz".to_string()),
                name: Some("get_weather".to_string()),
            },
        };

        let result = provider.process_stream_event(&event, &mut accumulator);
        assert!(result.unwrap().is_none());
        assert!(accumulator
            .tool_call_metadata_by_block_index
            .contains_key(&1));
        let metadata = &accumulator.tool_call_metadata_by_block_index[&1];
        assert_eq!(metadata.tool_call_id, "call_xyz");
        assert_eq!(metadata.tool_name, "get_weather");
    }

    #[test]
    fn test_process_text_delta_emits_chunk() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();
        accumulator.message_id = "msg_1".to_string();
        accumulator.message_model = "claude-sonnet-4-20250514".to_string();

        let event = AnthropicStreamEvent::ContentBlockDelta {
            index: 0,
            delta: AnthropicStreamContentDelta::TextDelta {
                text: "Hello world".to_string(),
            },
        };

        let result = provider
            .process_stream_event(&event, &mut accumulator)
            .unwrap();
        let chunk = result.unwrap();

        assert_eq!(chunk.id, "msg_1");
        assert_eq!(chunk.model, "claude-sonnet-4-20250514");
        assert_eq!(chunk.content_delta, "Hello world");
        assert!(chunk.tool_call_deltas.is_empty());
        assert!(!chunk.done);
    }

    #[test]
    fn test_process_input_json_delta_accumulates_and_emits_chunk() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();
        accumulator.message_id = "msg_1".to_string();
        accumulator.message_model = "model".to_string();
        accumulator.tool_call_metadata_by_block_index.insert(
            1,
            AnthropicStreamToolCallMetadata {
                tool_call_id: "call_1".to_string(),
                tool_name: "get_weather".to_string(),
            },
        );
        accumulator
            .accumulated_tool_input_json_by_block_index
            .insert(1, String::new());

        // First JSON delta.
        let event1 = AnthropicStreamEvent::ContentBlockDelta {
            index: 1,
            delta: AnthropicStreamContentDelta::InputJsonDelta {
                partial_json: "{\"city\"".to_string(),
            },
        };

        let chunk1 = provider
            .process_stream_event(&event1, &mut accumulator)
            .unwrap()
            .unwrap();
        assert_eq!(chunk1.tool_call_deltas.len(), 1);
        assert_eq!(chunk1.tool_call_deltas[0].id, "call_1");
        assert_eq!(chunk1.tool_call_deltas[0].function_name, "get_weather");
        assert_eq!(
            chunk1.tool_call_deltas[0].function_arguments_delta,
            "{\"city\""
        );

        // Second JSON delta.
        let event2 = AnthropicStreamEvent::ContentBlockDelta {
            index: 1,
            delta: AnthropicStreamContentDelta::InputJsonDelta {
                partial_json: ":\"SF\"}".to_string(),
            },
        };

        provider
            .process_stream_event(&event2, &mut accumulator)
            .unwrap();

        // Verify accumulation.
        assert_eq!(
            accumulator.accumulated_tool_input_json_by_block_index[&1],
            "{\"city\":\"SF\"}"
        );
    }

    #[test]
    fn test_process_message_delta_captures_stop_reason_and_usage() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();

        let event = AnthropicStreamEvent::MessageDelta {
            delta: AnthropicStreamMessageDeltaPayload {
                stop_reason: Some("end_turn".to_string()),
            },
            usage: Some(AnthropicStreamMessageDeltaUsage { output_tokens: 42 }),
        };

        let result = provider.process_stream_event(&event, &mut accumulator);
        assert!(result.unwrap().is_none());
        assert_eq!(accumulator.stop_reason.as_deref(), Some("stop"));
        assert_eq!(accumulator.completion_tokens, 42);
    }

    #[test]
    fn test_process_message_stop_emits_done_chunk() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();
        accumulator.message_id = "msg_final".to_string();
        accumulator.message_model = "model".to_string();
        accumulator.prompt_tokens = 100;
        accumulator.completion_tokens = 50;
        accumulator.stop_reason = Some("stop".to_string());

        let event = AnthropicStreamEvent::MessageStop;

        let chunk = provider
            .process_stream_event(&event, &mut accumulator)
            .unwrap()
            .unwrap();

        assert!(chunk.done);
        assert_eq!(chunk.finish_reason.as_deref(), Some("stop"));
        assert_eq!(chunk.prompt_tokens, Some(100));
        assert_eq!(chunk.completion_tokens, Some(50));
    }

    #[test]
    fn test_process_message_stop_includes_accumulated_tool_calls() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();
        accumulator.message_id = "msg_1".to_string();
        accumulator.message_model = "model".to_string();
        accumulator.stop_reason = Some("tool_calls".to_string());

        // Simulate accumulated tool call.
        accumulator.tool_call_metadata_by_block_index.insert(
            0,
            AnthropicStreamToolCallMetadata {
                tool_call_id: "call_1".to_string(),
                tool_name: "get_weather".to_string(),
            },
        );
        accumulator
            .accumulated_tool_input_json_by_block_index
            .insert(0, r#"{"city":"SF"}"#.to_string());

        let event = AnthropicStreamEvent::MessageStop;

        let chunk = provider
            .process_stream_event(&event, &mut accumulator)
            .unwrap()
            .unwrap();

        assert!(chunk.done);
        assert_eq!(chunk.tool_call_deltas.len(), 1);
        assert_eq!(chunk.tool_call_deltas[0].id, "call_1");
        assert_eq!(chunk.tool_call_deltas[0].function_name, "get_weather");
    }

    #[test]
    fn test_process_error_event_returns_error() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();

        let event = AnthropicStreamEvent::Error {
            error: AnthropicResponseError {
                message: "Overloaded".to_string(),
                error_type: "overloaded_error".to_string(),
            },
        };

        let result = provider.process_stream_event(&event, &mut accumulator);
        let error = result.unwrap_err();
        assert_eq!(error.error_type, "overloaded_error");
        assert!(error.is_retryable);
    }

    #[test]
    fn test_process_ping_event_returns_none() {
        let provider = AnthropicProvider::new("key", "");
        let mut accumulator = AnthropicStreamAccumulator::new();

        let event = AnthropicStreamEvent::Ping;

        let result = provider.process_stream_event(&event, &mut accumulator);
        assert!(result.unwrap().is_none());
    }

    // -----------------------------------------------------------------------
    // Error construction tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_http_error_classification_auth() {
        let provider = AnthropicProvider::new("key", "");
        let error = provider.build_http_error(reqwest::StatusCode::UNAUTHORIZED, "bad key");

        assert_eq!(error.error_type, "auth");
        assert!(!error.is_retryable);
        assert_eq!(error.provider, "anthropic");
    }

    #[test]
    fn test_http_error_classification_rate_limit() {
        let provider = AnthropicProvider::new("key", "");
        let error =
            provider.build_http_error(reqwest::StatusCode::TOO_MANY_REQUESTS, "rate limited");

        assert_eq!(error.error_type, "rate_limit");
        assert!(error.is_retryable);
    }

    #[test]
    fn test_http_error_classification_server_error() {
        let provider = AnthropicProvider::new("key", "");
        let error = provider.build_http_error(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "internal error",
        );

        assert_eq!(error.error_type, "server");
        assert!(error.is_retryable);
    }

    #[test]
    fn test_api_error_retryable_classification() {
        let provider = AnthropicProvider::new("key", "");

        let rate_limit_error = AnthropicResponseError {
            message: "Too many requests".to_string(),
            error_type: "rate_limit_error".to_string(),
        };
        assert!(provider.build_api_error(&rate_limit_error).is_retryable);

        let overloaded_error = AnthropicResponseError {
            message: "Overloaded".to_string(),
            error_type: "overloaded_error".to_string(),
        };
        assert!(provider.build_api_error(&overloaded_error).is_retryable);

        let api_error = AnthropicResponseError {
            message: "Internal".to_string(),
            error_type: "api_error".to_string(),
        };
        assert!(provider.build_api_error(&api_error).is_retryable);

        let invalid_request_error = AnthropicResponseError {
            message: "Bad request".to_string(),
            error_type: "invalid_request_error".to_string(),
        };
        assert!(!provider.build_api_error(&invalid_request_error).is_retryable);
    }

    // -----------------------------------------------------------------------
    // Stream accumulator tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_accumulator_builds_completed_tool_calls_in_order() {
        let mut accumulator = AnthropicStreamAccumulator::new();

        accumulator.tool_call_metadata_by_block_index.insert(
            2,
            AnthropicStreamToolCallMetadata {
                tool_call_id: "call_b".to_string(),
                tool_name: "write_file".to_string(),
            },
        );
        accumulator
            .accumulated_tool_input_json_by_block_index
            .insert(2, r#"{"content":"hi"}"#.to_string());

        accumulator.tool_call_metadata_by_block_index.insert(
            0,
            AnthropicStreamToolCallMetadata {
                tool_call_id: "call_a".to_string(),
                tool_name: "read_file".to_string(),
            },
        );
        accumulator
            .accumulated_tool_input_json_by_block_index
            .insert(0, r#"{"path":"/tmp"}"#.to_string());

        let tool_calls = accumulator.build_completed_tool_calls();

        assert_eq!(tool_calls.len(), 2);
        // Should be sorted by block index: 0 first, then 2.
        assert_eq!(tool_calls[0].id, "call_a");
        assert_eq!(tool_calls[0].function_name, "read_file");
        assert_eq!(tool_calls[0].function_arguments, r#"{"path":"/tmp"}"#);
        assert_eq!(tool_calls[1].id, "call_b");
        assert_eq!(tool_calls[1].function_name, "write_file");
    }

    // -----------------------------------------------------------------------
    // Request body serialization format tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_request_content_text_serializes_as_string() {
        let content = AnthropicRequestContent::Text("hello".to_string());
        let json = serde_json::to_string(&content).unwrap();
        assert_eq!(json, "\"hello\"");
    }

    #[test]
    fn test_request_content_blocks_serializes_as_array() {
        let content = AnthropicRequestContent::Blocks(vec![
            AnthropicRequestContentBlock::Text(AnthropicRequestTextBlock {
                block_type: "text".to_string(),
                text: "hello".to_string(),
            }),
        ]);
        let json = serde_json::to_string(&content).unwrap();
        assert!(json.starts_with('['));
        assert!(json.contains("\"type\":\"text\""));
        assert!(json.contains("\"text\":\"hello\""));
    }

    #[test]
    fn test_tool_use_block_serializes_with_input_as_object() {
        let block = AnthropicRequestContentBlock::ToolUse(AnthropicRequestToolUseBlock {
            block_type: "tool_use".to_string(),
            id: "call_1".to_string(),
            name: "get_weather".to_string(),
            input: serde_json::json!({"city": "SF"}),
        });

        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"type\":\"tool_use\""));
        assert!(json.contains("\"id\":\"call_1\""));
        assert!(json.contains("\"name\":\"get_weather\""));
        assert!(json.contains("\"input\":{\"city\":\"SF\"}"));
    }

    #[test]
    fn test_tool_result_block_serialization() {
        let block = AnthropicRequestContentBlock::ToolResult(AnthropicRequestToolResultBlock {
            block_type: "tool_result".to_string(),
            tool_use_id: "call_1".to_string(),
            content: "72F sunny".to_string(),
        });

        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"type\":\"tool_result\""));
        assert!(json.contains("\"tool_use_id\":\"call_1\""));
        assert!(json.contains("\"content\":\"72F sunny\""));
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

    // -----------------------------------------------------------------------
    // Full message conversion round-trip test
    // -----------------------------------------------------------------------

    #[test]
    fn test_full_conversation_message_conversion() {
        // Simulate a full conversation: system, user, assistant with tool call,
        // two tool results (should merge), assistant response.
        let messages = vec![
            LlmChatMessage {
                role: "system".to_string(),
                content: "You are a helpful weather assistant".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
            LlmChatMessage {
                role: "user".to_string(),
                content: "What is the weather in SF and NYC?".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
            LlmChatMessage {
                role: "assistant".to_string(),
                content: "Let me check both cities.".to_string(),
                tool_calls: vec![
                    LlmToolCall {
                        id: "call_1".to_string(),
                        call_type: "function".to_string(),
                        function_name: "get_weather".to_string(),
                        function_arguments: r#"{"city":"SF"}"#.to_string(),
                    },
                    LlmToolCall {
                        id: "call_2".to_string(),
                        call_type: "function".to_string(),
                        function_name: "get_weather".to_string(),
                        function_arguments: r#"{"city":"NYC"}"#.to_string(),
                    },
                ],
                tool_call_id: String::new(),
                name: String::new(),
            },
            LlmChatMessage {
                role: "tool".to_string(),
                content: "72F sunny".to_string(),
                tool_calls: vec![],
                tool_call_id: "call_1".to_string(),
                name: "get_weather".to_string(),
            },
            LlmChatMessage {
                role: "tool".to_string(),
                content: "45F cloudy".to_string(),
                tool_calls: vec![],
                tool_call_id: "call_2".to_string(),
                name: "get_weather".to_string(),
            },
            LlmChatMessage {
                role: "assistant".to_string(),
                content: "SF is 72F and sunny. NYC is 45F and cloudy.".to_string(),
                tool_calls: vec![],
                tool_call_id: String::new(),
                name: String::new(),
            },
        ];

        // System prompt extraction.
        let system = AnthropicProvider::extract_system_prompt_from_messages(&messages);
        assert_eq!(
            system.as_deref(),
            Some("You are a helpful weather assistant")
        );

        // Message conversion.
        let converted = AnthropicProvider::convert_messages_to_anthropic_format(&messages);

        // Should have: user, assistant (with tool calls), user (merged tool results), assistant.
        assert_eq!(converted.len(), 4);

        assert_eq!(converted[0].role, "user");
        assert_eq!(converted[1].role, "assistant");
        assert_eq!(converted[2].role, "user"); // merged tool results
        assert_eq!(converted[3].role, "assistant");

        // Verify merged tool results.
        match &converted[2].content {
            AnthropicRequestContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 2);
            }
            _ => panic!("expected Blocks for merged tool results"),
        }

        // Verify the final assistant message is plain text.
        match &converted[3].content {
            AnthropicRequestContent::Text(text) => {
                assert_eq!(text, "SF is 72F and sunny. NYC is 45F and cloudy.");
            }
            _ => panic!("expected Text for final assistant message"),
        }
    }
}
