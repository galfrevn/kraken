use std::collections::HashMap;
use std::fmt;

use super::anthropic_provider::AnthropicProvider;
use super::openai_provider::OpenAiCompatibleProvider;
use super::types::{
    LlmCompletionRequest, LlmCompletionResponse, LlmProvider, LlmProviderError, LlmStreamChunk,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default provider name when `LLM_PROVIDER` is not set.
const DEFAULT_PROVIDER_NAME: &str = "openrouter";

/// Default base URL for a local Ollama instance (OpenAI-compatible API).
const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";

// ---------------------------------------------------------------------------
// LlmProviderRouter
// ---------------------------------------------------------------------------

/// Routes LLM completion requests to the appropriate provider based on the
/// request's `provider` field or the configured default.
///
/// The router is **not** itself an `LlmProvider` -- it is a coordinator that
/// holds multiple provider instances and delegates to them.
pub struct LlmProviderRouter {
    /// Provider instances keyed by their canonical name (e.g. "openrouter",
    /// "openai", "anthropic", "ollama").
    providers: HashMap<String, Box<dyn LlmProvider>>,

    /// Name of the provider to use when a request does not specify one.
    default_provider_name: String,
}

impl fmt::Debug for LlmProviderRouter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LlmProviderRouter")
            .field(
                "providers",
                &self.providers.keys().collect::<Vec<_>>(),
            )
            .field("default_provider_name", &self.default_provider_name)
            .finish()
    }
}

impl LlmProviderRouter {
    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// Create a router by reading environment variables to discover which
    /// providers have credentials configured.
    ///
    /// # Provider discovery
    ///
    /// | Provider    | Required env var(s)                                        | Optional env var        |
    /// |-------------|------------------------------------------------------------|-------------------------|
    /// | OpenRouter  | `OPENROUTER_API_KEY` or `KRAKEN_OPENROUTER_API_KEY`        | `OPENROUTER_BASE_URL`   |
    /// | OpenAI      | `OPENAI_API_KEY`                                           | `OPENAI_BASE_URL`       |
    /// | Anthropic   | `ANTHROPIC_API_KEY`                                        | `ANTHROPIC_BASE_URL`    |
    /// | Ollama      | `OLLAMA_BASE_URL` (no API key needed)                      | --                      |
    ///
    /// The default provider is selected from `LLM_PROVIDER` (falling back to
    /// `"openrouter"`). If the default is not among the configured providers
    /// the router falls back to the first available provider.
    ///
    /// # Errors
    ///
    /// Returns an `LlmProviderError` if no providers could be configured
    /// (i.e. no API keys or Ollama URL were found in the environment).
    pub fn from_environment() -> Result<Self, LlmProviderError> {
        let mut providers: HashMap<String, Box<dyn LlmProvider>> = HashMap::new();

        // -- OpenRouter -------------------------------------------------------
        let openrouter_api_key = std::env::var("OPENROUTER_API_KEY")
            .or_else(|_| std::env::var("KRAKEN_OPENROUTER_API_KEY"))
            .ok();

        if let Some(api_key) = openrouter_api_key {
            let base_url = std::env::var("OPENROUTER_BASE_URL").unwrap_or_default();
            let provider = OpenAiCompatibleProvider::new("openrouter", &api_key, &base_url);
            tracing::info!(
                provider = "openrouter",
                "initialized OpenRouter LLM provider"
            );
            providers.insert("openrouter".to_string(), Box::new(provider));
        }

        // -- OpenAI -----------------------------------------------------------
        if let Ok(api_key) = std::env::var("OPENAI_API_KEY") {
            let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_default();
            let provider = OpenAiCompatibleProvider::new("openai", &api_key, &base_url);
            tracing::info!(provider = "openai", "initialized OpenAI LLM provider");
            providers.insert("openai".to_string(), Box::new(provider));
        }

        // -- Anthropic --------------------------------------------------------
        if let Ok(api_key) = std::env::var("ANTHROPIC_API_KEY") {
            let base_url = std::env::var("ANTHROPIC_BASE_URL").unwrap_or_default();
            let provider = AnthropicProvider::new(&api_key, &base_url);
            tracing::info!(
                provider = "anthropic",
                "initialized Anthropic LLM provider"
            );
            providers.insert("anthropic".to_string(), Box::new(provider));
        }

        // -- Ollama -----------------------------------------------------------
        // Ollama requires no API key. If `OLLAMA_BASE_URL` is set the user
        // explicitly wants it; otherwise we skip it.
        if let Ok(base_url) = std::env::var("OLLAMA_BASE_URL") {
            let resolved_base_url = if base_url.is_empty() {
                OLLAMA_DEFAULT_BASE_URL.to_string()
            } else {
                base_url
            };
            let provider = OpenAiCompatibleProvider::new("ollama", "", &resolved_base_url);
            tracing::info!(
                provider = "ollama",
                base_url = %resolved_base_url,
                "initialized Ollama LLM provider"
            );
            providers.insert("ollama".to_string(), Box::new(provider));
        }

        // -- Validate at least one provider -----------------------------------
        if providers.is_empty() {
            return Err(LlmProviderError {
                message: "no LLM providers configured -- set at least one API key \
                          (OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY) \
                          or OLLAMA_BASE_URL"
                    .to_string(),
                error_type: "configuration".to_string(),
                provider: "router".to_string(),
                is_retryable: false,
            });
        }

        // -- Determine default provider name ----------------------------------
        let requested_default =
            std::env::var("LLM_PROVIDER").unwrap_or_else(|_| DEFAULT_PROVIDER_NAME.to_string());

        let default_provider_name = if providers.contains_key(&requested_default) {
            tracing::info!(
                default_provider = %requested_default,
                "using requested default LLM provider"
            );
            requested_default
        } else {
            // Fall back to the first available provider (HashMap iteration
            // order is arbitrary, but deterministic for a single run).
            let fallback = providers.keys().next().unwrap().clone();
            tracing::info!(
                requested = %requested_default,
                fallback = %fallback,
                "requested default provider not configured, falling back"
            );
            fallback
        };

        tracing::info!(
            provider_count = providers.len(),
            available = ?providers.keys().collect::<Vec<_>>(),
            default = %default_provider_name,
            "LLM provider router initialised"
        );

        Ok(Self {
            providers,
            default_provider_name,
        })
    }

    // -----------------------------------------------------------------------
    // Completion methods
    // -----------------------------------------------------------------------

    /// Perform a non-streaming completion request, routing to the provider
    /// indicated by `request.provider` (or the default if empty).
    pub async fn complete(
        &self,
        request: LlmCompletionRequest,
    ) -> Result<LlmCompletionResponse, LlmProviderError> {
        let provider = self.resolve_provider(&request.provider)?;
        provider.complete(request).await
    }

    /// Perform a streaming completion request, routing to the provider
    /// indicated by `request.provider` (or the default if empty).
    ///
    /// The `callback` is invoked for every incremental chunk received from the
    /// upstream provider. If it returns `Err`, the stream is aborted.
    pub async fn stream_complete(
        &self,
        request: LlmCompletionRequest,
        callback: Box<dyn Fn(LlmStreamChunk) -> Result<(), String> + Send>,
    ) -> Result<(), LlmProviderError> {
        let provider = self.resolve_provider(&request.provider)?;
        provider.stream_complete(request, callback).await
    }

    // -----------------------------------------------------------------------
    // Accessors
    // -----------------------------------------------------------------------

    /// Returns the name of the default provider.
    pub fn default_provider_name(&self) -> &str {
        &self.default_provider_name
    }

    /// Returns the names of all configured providers.
    pub fn available_providers(&self) -> Vec<&str> {
        self.providers.keys().map(|key| key.as_str()).collect()
    }

    /// Returns `true` if a provider with the given `name` is configured.
    pub fn has_provider(&self, name: &str) -> bool {
        self.providers.contains_key(name)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Look up the provider for the given name, falling back to the default
    /// when `provider_name` is empty.
    fn resolve_provider(&self, provider_name: &str) -> Result<&dyn LlmProvider, LlmProviderError> {
        let name = if provider_name.is_empty() {
            &self.default_provider_name
        } else {
            provider_name
        };

        self.providers
            .get(name)
            .map(|boxed| boxed.as_ref())
            .ok_or_else(|| LlmProviderError {
                message: format!(
                    "provider '{}' is not configured -- available providers: {:?}",
                    name,
                    self.available_providers(),
                ),
                error_type: "configuration".to_string(),
                provider: "router".to_string(),
                is_retryable: false,
            })
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// Helper to clear all provider-related environment variables so tests
    /// start from a known clean state.
    ///
    /// # Safety
    ///
    /// `std::env::remove_var` is unsafe in Rust 2024 because mutating
    /// environment variables is not thread-safe. These tests use
    /// `#[serial]` to ensure they never run concurrently.
    unsafe fn clear_provider_env_vars() {
        unsafe {
            std::env::remove_var("OPENROUTER_API_KEY");
            std::env::remove_var("KRAKEN_OPENROUTER_API_KEY");
            std::env::remove_var("OPENAI_API_KEY");
            std::env::remove_var("ANTHROPIC_API_KEY");
            std::env::remove_var("OLLAMA_BASE_URL");
            std::env::remove_var("LLM_PROVIDER");
            std::env::remove_var("OPENROUTER_BASE_URL");
            std::env::remove_var("OPENAI_BASE_URL");
            std::env::remove_var("ANTHROPIC_BASE_URL");
        }
    }

    /// When no environment variables are set the router must return an error.
    #[test]
    #[serial]
    fn from_environment_no_providers_returns_error() {
        unsafe { clear_provider_env_vars() };

        let result = LlmProviderRouter::from_environment();
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert_eq!(error.error_type, "configuration");
        assert!(error.message.contains("no LLM providers configured"));
    }

    /// Setting `OPENAI_API_KEY` should register the OpenAI provider.
    #[test]
    #[serial]
    fn from_environment_with_openai_key() {
        unsafe { clear_provider_env_vars() };
        unsafe { std::env::set_var("OPENAI_API_KEY", "sk-test-key") };

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        assert!(router.has_provider("openai"));
        assert_eq!(router.available_providers(), vec!["openai"]);
        // Default should fall back to the only configured provider.
        assert_eq!(router.default_provider_name(), "openai");

        unsafe { std::env::remove_var("OPENAI_API_KEY") };
    }

    /// Setting `LLM_PROVIDER` should be respected when the provider exists.
    #[test]
    #[serial]
    fn from_environment_respects_llm_provider_env() {
        unsafe { clear_provider_env_vars() };
        unsafe {
            std::env::set_var("OPENAI_API_KEY", "sk-test-key");
            std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-test");
            std::env::set_var("LLM_PROVIDER", "anthropic");
        }

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        assert!(router.has_provider("openai"));
        assert!(router.has_provider("anthropic"));
        assert_eq!(router.default_provider_name(), "anthropic");

        unsafe {
            std::env::remove_var("OPENAI_API_KEY");
            std::env::remove_var("ANTHROPIC_API_KEY");
            std::env::remove_var("LLM_PROVIDER");
        }
    }

    /// When `LLM_PROVIDER` names a provider that isn't configured, the router
    /// should fall back to the first available provider.
    #[test]
    #[serial]
    fn from_environment_falls_back_when_default_not_configured() {
        unsafe { clear_provider_env_vars() };
        unsafe {
            std::env::set_var("OPENAI_API_KEY", "sk-test-key");
            std::env::set_var("LLM_PROVIDER", "nonexistent");
        }

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        // Should fall back to the only available provider.
        assert_eq!(router.default_provider_name(), "openai");

        unsafe {
            std::env::remove_var("OPENAI_API_KEY");
            std::env::remove_var("LLM_PROVIDER");
        }
    }

    /// Setting `OLLAMA_BASE_URL` should register the Ollama provider even
    /// without an API key.
    #[test]
    #[serial]
    fn from_environment_with_ollama() {
        unsafe { clear_provider_env_vars() };
        unsafe { std::env::set_var("OLLAMA_BASE_URL", "http://my-ollama:11434/v1") };

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        assert!(router.has_provider("ollama"));
        assert_eq!(router.default_provider_name(), "ollama");

        unsafe { std::env::remove_var("OLLAMA_BASE_URL") };
    }

    /// `resolve_provider` returns the correct provider and the default when
    /// the name is empty.
    #[test]
    #[serial]
    fn resolve_provider_uses_default_when_empty() {
        unsafe { clear_provider_env_vars() };
        unsafe { std::env::set_var("OPENAI_API_KEY", "sk-test-key") };

        let router = LlmProviderRouter::from_environment().expect("should succeed");

        // Empty string should resolve to default.
        let provider = router.resolve_provider("").expect("should resolve");
        assert_eq!(provider.provider_name(), "openai");

        // Explicit name should also work.
        let provider = router.resolve_provider("openai").expect("should resolve");
        assert_eq!(provider.provider_name(), "openai");

        // Unknown name should fail.
        match router.resolve_provider("unknown") {
            Ok(_) => panic!("expected error for unknown provider"),
            Err(error) => assert_eq!(error.error_type, "configuration"),
        }

        unsafe { std::env::remove_var("OPENAI_API_KEY") };
    }

    /// `KRAKEN_OPENROUTER_API_KEY` should work as a fallback for
    /// `OPENROUTER_API_KEY`.
    #[test]
    #[serial]
    fn from_environment_with_kraken_openrouter_key() {
        unsafe { clear_provider_env_vars() };
        unsafe { std::env::set_var("KRAKEN_OPENROUTER_API_KEY", "sk-or-test") };

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        assert!(router.has_provider("openrouter"));
        assert_eq!(router.default_provider_name(), "openrouter");

        unsafe { std::env::remove_var("KRAKEN_OPENROUTER_API_KEY") };
    }
}
