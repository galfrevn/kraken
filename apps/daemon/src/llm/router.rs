use std::collections::HashMap;
use std::fmt;

use super::openai_provider::OpenAiCompatibleProvider;
use super::types::{
    LlmCompletionRequest, LlmCompletionResponse, LlmProvider, LlmProviderError, LlmStreamChunk,
};

const DEFAULT_PROVIDER_NAME: &str = "openrouter";

const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";

pub struct LlmProviderRouter {
    providers: HashMap<String, Box<dyn LlmProvider>>,

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
    pub fn empty() -> Self {
        Self {
            providers: HashMap::new(),
            default_provider_name: String::new(),
        }
    }

    pub fn has_any_providers(&self) -> bool {
        !self.providers.is_empty()
    }

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

        // -- Ollama -----------------------------------------------------------
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

        if providers.is_empty() {
            return Err(LlmProviderError {
                message: "no LLM providers configured -- set OPENROUTER_API_KEY \
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
            let fallback = if providers.contains_key("openrouter") {
                "openrouter".to_string()
            } else {
                providers.keys().next().unwrap().clone()
            };
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

    pub async fn complete(
        &self,
        request: LlmCompletionRequest,
    ) -> Result<LlmCompletionResponse, LlmProviderError> {
        let provider = self.resolve_provider(&request.provider)?;
        provider.complete(request).await
    }

    pub async fn stream_complete(
        &self,
        request: LlmCompletionRequest,
        callback: Box<dyn Fn(LlmStreamChunk) -> Result<(), String> + Send>,
    ) -> Result<(), LlmProviderError> {
        let provider = self.resolve_provider(&request.provider)?;
        provider.stream_complete(request, callback).await
    }

    pub fn default_provider_name(&self) -> &str {
        &self.default_provider_name
    }

    pub fn available_providers(&self) -> Vec<&str> {
        self.providers.keys().map(|key| key.as_str()).collect()
    }

    #[allow(dead_code)]
    pub fn has_provider(&self, name: &str) -> bool {
        self.providers.contains_key(name)
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    unsafe fn clear_provider_env_vars() {
        unsafe {
            std::env::remove_var("OPENROUTER_API_KEY");
            std::env::remove_var("KRAKEN_OPENROUTER_API_KEY");
            std::env::remove_var("OLLAMA_BASE_URL");
            std::env::remove_var("LLM_PROVIDER");
            std::env::remove_var("OPENROUTER_BASE_URL");
        }
    }

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

    #[test]
    #[serial]
    fn from_environment_with_openrouter_key() {
        unsafe { clear_provider_env_vars() };
        unsafe { std::env::set_var("OPENROUTER_API_KEY", "sk-or-test-key") };

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        assert!(router.has_provider("openrouter"));
        assert_eq!(router.default_provider_name(), "openrouter");

        unsafe { std::env::remove_var("OPENROUTER_API_KEY") };
    }

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

    #[test]
    #[serial]
    fn from_environment_defaults_to_openrouter_over_ollama() {
        unsafe { clear_provider_env_vars() };
        unsafe {
            std::env::set_var("OPENROUTER_API_KEY", "sk-or-test-key");
            std::env::set_var("OLLAMA_BASE_URL", "http://my-ollama:11434/v1");
        }

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        assert!(router.has_provider("openrouter"));
        assert!(router.has_provider("ollama"));
        assert_eq!(router.default_provider_name(), "openrouter");

        unsafe {
            std::env::remove_var("OPENROUTER_API_KEY");
            std::env::remove_var("OLLAMA_BASE_URL");
        }
    }

    #[test]
    #[serial]
    fn from_environment_falls_back_when_default_not_configured() {
        unsafe { clear_provider_env_vars() };
        unsafe {
            std::env::set_var("OPENROUTER_API_KEY", "sk-or-test-key");
            std::env::set_var("LLM_PROVIDER", "nonexistent");
        }

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        assert_eq!(router.default_provider_name(), "openrouter");

        unsafe {
            std::env::remove_var("OPENROUTER_API_KEY");
            std::env::remove_var("LLM_PROVIDER");
        }
    }

    #[test]
    #[serial]
    fn resolve_provider_uses_default_when_empty() {
        unsafe { clear_provider_env_vars() };
        unsafe { std::env::set_var("OPENROUTER_API_KEY", "sk-or-test-key") };

        let router = LlmProviderRouter::from_environment().expect("should succeed");

        let provider = router.resolve_provider("").expect("should resolve");
        assert_eq!(provider.provider_name(), "openrouter");

        let provider = router.resolve_provider("openrouter").expect("should resolve");
        assert_eq!(provider.provider_name(), "openrouter");

        match router.resolve_provider("unknown") {
            Ok(_) => panic!("expected error for unknown provider"),
            Err(error) => assert_eq!(error.error_type, "configuration"),
        }

        unsafe { std::env::remove_var("OPENROUTER_API_KEY") };
    }

    #[test]
    fn empty_router_has_no_providers() {
        let empty_router = LlmProviderRouter::empty();
        assert!(!empty_router.has_any_providers());
        assert!(empty_router.available_providers().is_empty());
        assert_eq!(empty_router.default_provider_name(), "");
    }

    #[test]
    fn empty_router_resolve_provider_returns_configuration_error() {
        let empty_router = LlmProviderRouter::empty();
        match empty_router.resolve_provider("openrouter") {
            Ok(_) => panic!("expected error for unconfigured provider on empty router"),
            Err(error) => {
                assert_eq!(error.error_type, "configuration");
                assert!(error.message.contains("not configured"));
            }
        }
    }

    #[test]
    #[serial]
    fn from_environment_has_any_providers_returns_true() {
        unsafe { clear_provider_env_vars() };
        unsafe { std::env::set_var("OPENROUTER_API_KEY", "sk-or-test-key") };

        let router = LlmProviderRouter::from_environment().expect("should succeed");
        assert!(router.has_any_providers());

        unsafe { std::env::remove_var("OPENROUTER_API_KEY") };
    }
}
