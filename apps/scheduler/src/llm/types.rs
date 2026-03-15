use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Chat message types
// ---------------------------------------------------------------------------

/// A chat message in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmChatMessage {
    /// Role of the message sender: "system", "user", "assistant", or "tool".
    pub role: String,
    /// Message text content.
    pub content: String,
    /// Tool calls requested by the assistant (only populated for assistant messages).
    pub tool_calls: Vec<LlmToolCall>,
    /// Identifier linking a tool-role message to its originating tool call.
    pub tool_call_id: String,
    /// Optional sender name.
    pub name: String,
}

/// A tool call made by the assistant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolCall {
    /// Unique identifier for this tool call.
    pub id: String,
    /// Type of call -- always "function".
    pub call_type: String,
    /// Name of the function to invoke.
    pub function_name: String,
    /// JSON-encoded string of arguments for the function.
    pub function_arguments: String,
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/// A tool definition sent to the LLM describing an available function.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolDefinition {
    /// The tool/function name.
    pub name: String,
    /// Human-readable description of what the tool does.
    pub description: String,
    /// JSON Schema describing the function's parameters.
    pub parameters_schema: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Completion request / response
// ---------------------------------------------------------------------------

/// Request payload for a (non-streaming) completion call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCompletionRequest {
    /// Model identifier (e.g. "gpt-4o", "claude-sonnet-4-20250514").
    pub model: String,
    /// The conversation history.
    pub messages: Vec<LlmChatMessage>,
    /// Sampling temperature (0.0 - 2.0).
    pub temperature: Option<f32>,
    /// Maximum number of tokens to generate.
    pub max_tokens: Option<i32>,
    /// Tools the model may call.
    pub tools: Vec<LlmToolDefinition>,
    /// Whether to request extended reasoning/thinking output.
    pub include_reasoning: bool,
    /// Routing hint for multi-provider setups -- not sent to the upstream API.
    pub provider: String,
}

/// Response from a non-streaming completion request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCompletionResponse {
    /// Provider-assigned response identifier.
    pub id: String,
    /// Model that produced the response.
    pub model: String,
    /// The assistant's text response.
    pub content: String,
    /// Tool calls the assistant wants to make, if any.
    pub tool_calls: Vec<LlmToolCall>,
    /// Why generation stopped: "stop", "tool_calls", or "length".
    pub finish_reason: String,
    /// Number of tokens in the prompt.
    pub prompt_tokens: i32,
    /// Number of tokens generated.
    pub completion_tokens: i32,
}

// ---------------------------------------------------------------------------
// Streaming types
// ---------------------------------------------------------------------------

/// A single incremental chunk received during a streaming completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmStreamChunk {
    /// Provider-assigned response identifier (same across all chunks).
    pub id: String,
    /// Model that produced the chunk.
    pub model: String,
    /// Incremental text content delta.
    pub content_delta: String,
    /// Incremental reasoning/thinking delta (if the model supports it).
    pub reasoning_delta: String,
    /// Incremental tool-call deltas for parallel or sequential calls.
    pub tool_call_deltas: Vec<LlmToolCallDelta>,
    /// Set only when the stream ends -- e.g. "stop", "tool_calls", "length".
    pub finish_reason: Option<String>,
    /// Token usage -- only populated at the end of the stream.
    pub prompt_tokens: Option<i32>,
    /// Token usage -- only populated at the end of the stream.
    pub completion_tokens: Option<i32>,
    /// `true` when this is the final chunk in the stream.
    pub done: bool,
}

/// An incremental delta for a single tool call within a streaming response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToolCallDelta {
    /// Index of the tool call this delta belongs to (supports parallel calls).
    pub index: i32,
    /// Tool-call identifier, populated in the first chunk for this index.
    pub id: String,
    /// Call type (always "function"), populated in the first chunk.
    pub call_type: String,
    /// Function name, populated in the first chunk.
    pub function_name: String,
    /// Incremental fragment of the JSON-encoded arguments string.
    pub function_arguments_delta: String,
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Error returned by an LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderError {
    /// Human-readable error message.
    pub message: String,
    /// Categorised error type (e.g. "rate_limit", "auth", "server").
    pub error_type: String,
    /// Name of the provider that produced this error.
    pub provider: String,
    /// Whether the caller should retry this request.
    pub is_retryable: bool,
}

impl std::fmt::Display for LlmProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "[{}] {} error: {} (retryable: {})",
            self.provider, self.error_type, self.message, self.is_retryable,
        )
    }
}

impl std::error::Error for LlmProviderError {}

// ---------------------------------------------------------------------------
// Provider trait
// ---------------------------------------------------------------------------

/// Trait that all LLM providers must implement.
///
/// Providers handle the details of communicating with a specific LLM API
/// (OpenAI-compatible, Anthropic, etc.) and translate between the canonical
/// Kraken types above and the provider's wire format.
#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    /// Perform a non-streaming completion request.
    async fn complete(
        &self,
        request: LlmCompletionRequest,
    ) -> Result<LlmCompletionResponse, LlmProviderError>;

    /// Perform a streaming completion request.
    ///
    /// The provider calls `callback` once for every incremental chunk it
    /// receives from the upstream API.  If the callback returns `Err`, the
    /// provider should abort the stream and propagate the error.
    async fn stream_complete(
        &self,
        request: LlmCompletionRequest,
        callback: Box<dyn Fn(LlmStreamChunk) -> Result<(), String> + Send>,
    ) -> Result<(), LlmProviderError>;

    /// The canonical name of this provider (e.g. "openai", "anthropic").
    fn provider_name(&self) -> &str;
}
