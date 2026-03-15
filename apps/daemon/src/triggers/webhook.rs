use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::{info, warn};
use uuid::Uuid;

use super::engine::TriggerEngine;
use super::types::{TriggerEvent, TriggerType, WebhookTriggerConfig};

type HmacSha256 = Hmac<Sha256>;

pub struct WebhookServer {
    trigger_engine: Arc<TriggerEngine>,
    webhook_configs: Vec<WebhookTriggerConfig>,
}

#[derive(Clone)]
struct WebhookHandlerState {
    trigger_engine: Arc<TriggerEngine>,
    webhook_configs: Arc<Vec<WebhookTriggerConfig>>,
}

impl WebhookServer {
    pub fn new(
        trigger_engine: Arc<TriggerEngine>,
        webhook_configs: Vec<WebhookTriggerConfig>,
    ) -> Self {
        Self {
            trigger_engine,
            webhook_configs,
        }
    }

    pub async fn start(
        self,
        port: u16,
        mut shutdown_receiver: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let handler_state = WebhookHandlerState {
            trigger_engine: self.trigger_engine,
            webhook_configs: Arc::new(self.webhook_configs),
        };

        let router = Router::new()
            .route("/webhooks/{provider}", post(handle_webhook_request))
            .with_state(handler_state);

        let listen_address = format!("0.0.0.0:{port}");
        let tcp_listener = TcpListener::bind(&listen_address)
            .await
            .map_err(|bind_error| format!("failed to bind webhook server on {listen_address}: {bind_error}"))?;

        info!(port = port, "webhook HTTP server starting");

        axum::serve(tcp_listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_receiver.changed().await;
            })
            .await
            .map_err(|serve_error| format!("webhook server error: {serve_error}"))?;

        info!("webhook HTTP server stopped");
        Ok(())
    }
}

async fn handle_webhook_request(
    Path(provider_name): Path<String>,
    State(handler_state): State<WebhookHandlerState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> impl IntoResponse {
    let matching_webhook_config = handler_state
        .webhook_configs
        .iter()
        .find(|config| config.provider == provider_name);

    let webhook_config = match matching_webhook_config {
        Some(config) => config,
        None => {
            warn!(
                provider = %provider_name,
                "received webhook for unconfigured provider"
            );
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({"error": "unknown provider"})),
            );
        }
    };

    let signature_validation_result = match provider_name.as_str() {
        "github" => validate_github_signature(&headers, &body_bytes, &webhook_config.secret),
        "gitlab" => validate_gitlab_token(&headers, &webhook_config.secret),
        _ => validate_github_signature(&headers, &body_bytes, &webhook_config.secret),
    };

    if let Err(signature_error_message) = signature_validation_result {
        warn!(
            provider = %provider_name,
            error = %signature_error_message,
            "webhook signature validation failed"
        );
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({"error": "signature validation failed"})),
        );
    }

    let extracted_event_type = extract_event_type_from_headers(&provider_name, &headers, &body_bytes);

    let parsed_body: Value = match serde_json::from_slice(&body_bytes) {
        Ok(parsed_value) => parsed_value,
        Err(parse_error) => {
            warn!(
                provider = %provider_name,
                error = %parse_error,
                "failed to parse webhook body as JSON"
            );
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({"error": "invalid JSON body"})),
            );
        }
    };

    let trigger_event_source = format!("webhook:{provider_name}:{extracted_event_type}");

    let trigger_event = TriggerEvent {
        id: Uuid::new_v4().to_string(),
        trigger_type: TriggerType::Webhook,
        source: trigger_event_source,
        payload: parsed_body,
        fired_at: Utc::now(),
    };

    let created_task_id = handler_state
        .trigger_engine
        .handle_trigger_event(trigger_event)
        .await;

    let task_was_created = created_task_id.is_some();

    info!(
        provider = %provider_name,
        event_type = %extracted_event_type,
        task_created = task_was_created,
        "webhook received and processed"
    );

    if task_was_created {
        (
            StatusCode::ACCEPTED,
            axum::Json(json!({"status": "accepted", "task_id": created_task_id})),
        )
    } else {
        (
            StatusCode::OK,
            axum::Json(json!({"status": "accepted"})),
        )
    }
}

fn validate_github_signature(
    request_headers: &HeaderMap,
    request_body: &[u8],
    webhook_secret: &str,
) -> Result<(), String> {
    let signature_header_value = request_headers
        .get("x-hub-signature-256")
        .and_then(|header_value| header_value.to_str().ok())
        .ok_or_else(|| "missing X-Hub-Signature-256 header".to_string())?;

    let hex_digest = signature_header_value
        .strip_prefix("sha256=")
        .ok_or_else(|| "X-Hub-Signature-256 header does not start with 'sha256='".to_string())?;

    let expected_signature_bytes = hex::decode(hex_digest)
        .map_err(|decode_error| format!("invalid hex in signature header: {decode_error}"))?;

    let mut hmac_instance = HmacSha256::new_from_slice(webhook_secret.as_bytes())
        .map_err(|hmac_error| format!("failed to create HMAC instance: {hmac_error}"))?;

    hmac_instance.update(request_body);
    let computed_signature_bytes = hmac_instance.finalize().into_bytes();

    if computed_signature_bytes
        .as_slice()
        .ct_eq(&expected_signature_bytes)
        .into()
    {
        Ok(())
    } else {
        Err("signature mismatch".to_string())
    }
}

fn validate_gitlab_token(
    request_headers: &HeaderMap,
    webhook_secret: &str,
) -> Result<(), String> {
    let provided_token = request_headers
        .get("x-gitlab-token")
        .and_then(|header_value| header_value.to_str().ok())
        .ok_or_else(|| "missing X-Gitlab-Token header".to_string())?;

    let provided_token_bytes = provided_token.as_bytes();
    let expected_token_bytes = webhook_secret.as_bytes();

    if provided_token_bytes.ct_eq(expected_token_bytes).into() {
        Ok(())
    } else {
        Err("token mismatch".to_string())
    }
}

fn extract_event_type_from_headers(
    provider_name: &str,
    request_headers: &HeaderMap,
    request_body: &[u8],
) -> String {
    let base_event_type = match provider_name {
        "github" => request_headers
            .get("x-github-event")
            .and_then(|header_value| header_value.to_str().ok())
            .unwrap_or("unknown")
            .to_string(),
        "gitlab" => request_headers
            .get("x-gitlab-event")
            .and_then(|header_value| header_value.to_str().ok())
            .unwrap_or("unknown")
            .to_string(),
        _ => request_headers
            .get("x-github-event")
            .or_else(|| request_headers.get("x-gitlab-event"))
            .and_then(|header_value| header_value.to_str().ok())
            .unwrap_or("unknown")
            .to_string(),
    };

    let payload_action = serde_json::from_slice::<Value>(request_body)
        .ok()
        .and_then(|parsed_json| {
            parsed_json
                .get("action")
                .and_then(|action_value| action_value.as_str().map(String::from))
        });

    match payload_action {
        Some(action_string) => format!("{base_event_type}.{action_string}"),
        None => base_event_type,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_database;
    use crate::db::tasks::TaskStore;
    use crate::triggers::types::{WebhookEventConfig, WebhookTriggerConfig};
    use axum::body::Body;
    use axum::http::Request;
    use hmac::Mac;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn create_test_webhook_configs(secret: &str) -> Vec<WebhookTriggerConfig> {
        vec![WebhookTriggerConfig {
            name: "test-github".to_string(),
            provider: "github".to_string(),
            secret: secret.to_string(),
            events: vec![WebhookEventConfig {
                event_type: "issues.opened".to_string(),
                filters: vec![],
                task_template: "Handle issue: {{event.issue.title}}".to_string(),
            }],
        }]
    }

    fn create_test_gitlab_webhook_configs(secret: &str) -> Vec<WebhookTriggerConfig> {
        vec![WebhookTriggerConfig {
            name: "test-gitlab".to_string(),
            provider: "gitlab".to_string(),
            secret: secret.to_string(),
            events: vec![WebhookEventConfig {
                event_type: "Issue Hook.opened".to_string(),
                filters: vec![],
                task_template: "Handle gitlab issue: {{event.object_attributes.title}}".to_string(),
            }],
        }]
    }

    async fn create_test_trigger_engine(
        webhook_configs: Vec<WebhookTriggerConfig>,
    ) -> Arc<TriggerEngine> {
        let temporary_directory = std::env::temp_dir();
        let database_path = temporary_directory.join(format!(
            "kraken_test_webhook_{}.sqlite",
            Uuid::new_v4()
        ));

        let database_pool =
            open_database(&database_path).expect("should open test database");

        let task_store = Arc::new(TaskStore::new(database_pool));

        Arc::new(TriggerEngine::new(
            task_store,
            webhook_configs.clone(),
            vec![],
            vec![],
        ))
    }

    fn compute_github_hmac_signature(secret: &str, body: &[u8]) -> String {
        let mut hmac_instance =
            HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC creation should succeed");
        hmac_instance.update(body);
        let signature_bytes = hmac_instance.finalize().into_bytes();
        format!("sha256={}", hex::encode(signature_bytes))
    }

    fn build_test_router(handler_state: WebhookHandlerState) -> Router {
        Router::new()
            .route("/webhooks/{provider}", post(handle_webhook_request))
            .with_state(handler_state)
    }

    #[test]
    fn test_github_signature_validation_with_valid_signature() {
        let webhook_secret = "test-secret-key-for-github";
        let request_body = b"test payload body";
        let valid_signature = compute_github_hmac_signature(webhook_secret, request_body);

        let mut headers = HeaderMap::new();
        headers.insert("x-hub-signature-256", valid_signature.parse().unwrap());

        let result = validate_github_signature(&headers, request_body, webhook_secret);
        assert!(result.is_ok());
    }

    #[test]
    fn test_github_signature_validation_with_invalid_signature() {
        let webhook_secret = "test-secret-key-for-github";
        let request_body = b"test payload body";

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-hub-signature-256",
            "sha256=0000000000000000000000000000000000000000000000000000000000000000"
                .parse()
                .unwrap(),
        );

        let result = validate_github_signature(&headers, request_body, webhook_secret);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("mismatch"));
    }

    #[test]
    fn test_github_signature_validation_with_missing_header() {
        let headers = HeaderMap::new();
        let result = validate_github_signature(&headers, b"body", "secret");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("missing"));
    }

    #[test]
    fn test_github_signature_validation_with_invalid_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert("x-hub-signature-256", "md5=abcdef".parse().unwrap());

        let result = validate_github_signature(&headers, b"body", "secret");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sha256="));
    }

    #[test]
    fn test_github_signature_validation_with_invalid_hex() {
        let mut headers = HeaderMap::new();
        headers.insert("x-hub-signature-256", "sha256=not-valid-hex".parse().unwrap());

        let result = validate_github_signature(&headers, b"body", "secret");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("hex"));
    }

    #[test]
    fn test_gitlab_token_validation_with_valid_token() {
        let webhook_secret = "gitlab-webhook-token";
        let mut headers = HeaderMap::new();
        headers.insert("x-gitlab-token", webhook_secret.parse().unwrap());

        let result = validate_gitlab_token(&headers, webhook_secret);
        assert!(result.is_ok());
    }

    #[test]
    fn test_gitlab_token_validation_with_invalid_token() {
        let mut headers = HeaderMap::new();
        headers.insert("x-gitlab-token", "wrong-token".parse().unwrap());

        let result = validate_gitlab_token(&headers, "correct-token");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("mismatch"));
    }

    #[test]
    fn test_gitlab_token_validation_with_missing_header() {
        let headers = HeaderMap::new();
        let result = validate_gitlab_token(&headers, "secret");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("missing"));
    }

    #[test]
    fn test_extract_event_type_github_with_action() {
        let mut headers = HeaderMap::new();
        headers.insert("x-github-event", "issues".parse().unwrap());

        let body = serde_json::to_vec(&json!({"action": "opened"})).unwrap();

        let event_type = extract_event_type_from_headers("github", &headers, &body);
        assert_eq!(event_type, "issues.opened");
    }

    #[test]
    fn test_extract_event_type_github_without_action() {
        let mut headers = HeaderMap::new();
        headers.insert("x-github-event", "push".parse().unwrap());

        let body = serde_json::to_vec(&json!({"ref": "refs/heads/main"})).unwrap();

        let event_type = extract_event_type_from_headers("github", &headers, &body);
        assert_eq!(event_type, "push");
    }

    #[test]
    fn test_extract_event_type_github_missing_header() {
        let headers = HeaderMap::new();
        let body = serde_json::to_vec(&json!({"action": "opened"})).unwrap();

        let event_type = extract_event_type_from_headers("github", &headers, &body);
        assert_eq!(event_type, "unknown.opened");
    }

    #[test]
    fn test_extract_event_type_gitlab() {
        let mut headers = HeaderMap::new();
        headers.insert("x-gitlab-event", "Issue Hook".parse().unwrap());

        let body = serde_json::to_vec(&json!({"action": "opened"})).unwrap();

        let event_type = extract_event_type_from_headers("gitlab", &headers, &body);
        assert_eq!(event_type, "Issue Hook.opened");
    }

    #[tokio::test]
    async fn test_full_handler_flow_github_webhook_creates_task() {
        let webhook_secret = "integration-test-secret";
        let webhook_configs = create_test_webhook_configs(webhook_secret);
        let trigger_engine = create_test_trigger_engine(webhook_configs.clone()).await;

        let handler_state = WebhookHandlerState {
            trigger_engine,
            webhook_configs: Arc::new(webhook_configs),
        };

        let router = build_test_router(handler_state);

        let request_body = serde_json::to_vec(&json!({
            "action": "opened",
            "issue": {
                "title": "Bug in webhook handler",
                "number": 99
            }
        }))
        .unwrap();

        let signature = compute_github_hmac_signature(webhook_secret, &request_body);

        let request = Request::builder()
            .method("POST")
            .uri("/webhooks/github")
            .header("x-hub-signature-256", signature)
            .header("x-github-event", "issues")
            .header("content-type", "application/json")
            .body(Body::from(request_body))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let response_body = response.into_body().collect().await.unwrap().to_bytes();
        let response_json: Value = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response_json["status"], "accepted");
        assert!(response_json["task_id"].is_string());
    }

    #[tokio::test]
    async fn test_full_handler_flow_invalid_signature_returns_unauthorized() {
        let webhook_configs = create_test_webhook_configs("real-secret");
        let trigger_engine = create_test_trigger_engine(webhook_configs.clone()).await;

        let handler_state = WebhookHandlerState {
            trigger_engine,
            webhook_configs: Arc::new(webhook_configs),
        };

        let router = build_test_router(handler_state);

        let request_body = b"{\"action\": \"opened\"}";

        let request = Request::builder()
            .method("POST")
            .uri("/webhooks/github")
            .header(
                "x-hub-signature-256",
                "sha256=0000000000000000000000000000000000000000000000000000000000000000",
            )
            .header("x-github-event", "issues")
            .header("content-type", "application/json")
            .body(Body::from(request_body.to_vec()))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_full_handler_flow_unknown_provider_returns_not_found() {
        let webhook_configs = create_test_webhook_configs("secret");
        let trigger_engine = create_test_trigger_engine(webhook_configs.clone()).await;

        let handler_state = WebhookHandlerState {
            trigger_engine,
            webhook_configs: Arc::new(webhook_configs),
        };

        let router = build_test_router(handler_state);

        let request = Request::builder()
            .method("POST")
            .uri("/webhooks/bitbucket")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_full_handler_flow_no_matching_event_returns_ok() {
        let webhook_secret = "test-secret";
        let webhook_configs = create_test_webhook_configs(webhook_secret);
        let trigger_engine = create_test_trigger_engine(webhook_configs.clone()).await;

        let handler_state = WebhookHandlerState {
            trigger_engine,
            webhook_configs: Arc::new(webhook_configs),
        };

        let router = build_test_router(handler_state);

        let request_body = serde_json::to_vec(&json!({
            "action": "closed",
            "issue": {
                "title": "Closed issue",
                "number": 1
            }
        }))
        .unwrap();

        let signature = compute_github_hmac_signature(webhook_secret, &request_body);

        let request = Request::builder()
            .method("POST")
            .uri("/webhooks/github")
            .header("x-hub-signature-256", signature)
            .header("x-github-event", "issues")
            .header("content-type", "application/json")
            .body(Body::from(request_body))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_full_handler_flow_gitlab_webhook_with_valid_token() {
        let webhook_secret = "gitlab-secret-token";
        let webhook_configs = create_test_gitlab_webhook_configs(webhook_secret);
        let trigger_engine = create_test_trigger_engine(webhook_configs.clone()).await;

        let handler_state = WebhookHandlerState {
            trigger_engine,
            webhook_configs: Arc::new(webhook_configs),
        };

        let router = build_test_router(handler_state);

        let request_body = serde_json::to_vec(&json!({
            "action": "opened",
            "object_attributes": {
                "title": "GitLab issue test"
            }
        }))
        .unwrap();

        let request = Request::builder()
            .method("POST")
            .uri("/webhooks/gitlab")
            .header("x-gitlab-token", webhook_secret)
            .header("x-gitlab-event", "Issue Hook")
            .header("content-type", "application/json")
            .body(Body::from(request_body))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn test_full_handler_flow_invalid_json_body_returns_bad_request() {
        let webhook_secret = "test-secret";
        let webhook_configs = create_test_webhook_configs(webhook_secret);
        let trigger_engine = create_test_trigger_engine(webhook_configs.clone()).await;

        let handler_state = WebhookHandlerState {
            trigger_engine,
            webhook_configs: Arc::new(webhook_configs),
        };

        let router = build_test_router(handler_state);

        let invalid_json_body = b"this is not json";
        let signature = compute_github_hmac_signature(webhook_secret, invalid_json_body);

        let request = Request::builder()
            .method("POST")
            .uri("/webhooks/github")
            .header("x-hub-signature-256", signature)
            .header("x-github-event", "push")
            .header("content-type", "application/json")
            .body(Body::from(invalid_json_body.to_vec()))
            .unwrap();

        let response = router.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
