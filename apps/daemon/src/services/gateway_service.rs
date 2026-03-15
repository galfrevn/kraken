use std::pin::Pin;
use std::sync::Arc;

use tokio_stream::Stream;
use tonic::{Request, Response, Status};
use tracing::info;

use crate::llm::router::LlmProviderRouter;
use crate::llm::types::LlmStreamChunk;
use crate::proto::agent::v1::{
    gateway_service_server::GatewayService,
    CompleteRequest, CompleteResponse, ChatMessage,
    HealthCheckRequest, HealthCheckResponse,
    ListWebhooksRequest, ListWebhooksResponse,
    RegisterWebhookRequest, RegisterWebhookResponse,
    StreamCompleteRequest, StreamCompleteResponse,
    StreamWebhookEventsRequest, StreamWebhookEventsResponse,
    UnregisterWebhookRequest, UnregisterWebhookResponse,
};
use crate::services::worker_service::convert_proto_request_to_llm_completion_request;

pub struct GatewayServiceImplementation {
    llm_provider_router: Arc<LlmProviderRouter>,
}

impl GatewayServiceImplementation {
    pub fn new(llm_provider_router: Arc<LlmProviderRouter>) -> Self {
        Self { llm_provider_router }
    }
}

#[tonic::async_trait]
impl GatewayService for GatewayServiceImplementation {
    async fn complete(
        &self,
        request: Request<CompleteRequest>,
    ) -> Result<Response<CompleteResponse>, Status> {
        let complete_request = request.into_inner();
        let llm_request = convert_proto_request_to_llm_completion_request(&complete_request)?;

        let llm_response = self
            .llm_provider_router
            .complete(llm_request)
            .await
            .map_err(|llm_error| {
                Status::internal(format!("LLM completion failed: {}", llm_error.message))
            })?;

        let response_message = Some(ChatMessage {
            role: "assistant".to_string(),
            content: llm_response.content,
            tool_calls: vec![],
            tool_call_id: String::new(),
            name: None,
        });

        Ok(Response::new(CompleteResponse {
            id: llm_response.id,
            model: llm_response.model,
            message: response_message,
            prompt_tokens: llm_response.prompt_tokens,
            completion_tokens: llm_response.completion_tokens,
            tool_calls: vec![],
            finish_reason: llm_response.finish_reason,
        }))
    }

    type StreamCompleteStream =
        Pin<Box<dyn Stream<Item = Result<StreamCompleteResponse, Status>> + Send>>;

    async fn stream_complete(
        &self,
        request: Request<StreamCompleteRequest>,
    ) -> Result<Response<Self::StreamCompleteStream>, Status> {
        let stream_request = request.into_inner();

        let equivalent_complete_request = CompleteRequest {
            model: stream_request.model,
            messages: stream_request.messages,
            temperature: stream_request.temperature,
            max_tokens: stream_request.max_tokens,
            system_prompt: stream_request.system_prompt,
            tools: stream_request.tools,
            provider: stream_request.provider,
        };

        let llm_request = convert_proto_request_to_llm_completion_request(&equivalent_complete_request)?;
        let llm_provider_router_for_stream = Arc::clone(&self.llm_provider_router);

        let (stream_chunk_sender, stream_chunk_receiver) =
            tokio::sync::mpsc::channel::<Result<StreamCompleteResponse, Status>>(32);

        tokio::spawn(async move {
            let sender_for_callback = stream_chunk_sender.clone();

            let streaming_result = llm_provider_router_for_stream
                .stream_complete(
                    llm_request,
                    Box::new(move |stream_chunk: LlmStreamChunk| {
                        let proto_response = StreamCompleteResponse {
                            id: stream_chunk.id,
                            delta: stream_chunk.content_delta,
                            done: stream_chunk.done,
                            prompt_tokens: stream_chunk.prompt_tokens.unwrap_or(0),
                            completion_tokens: stream_chunk.completion_tokens.unwrap_or(0),
                            tool_calls: vec![],
                            finish_reason: stream_chunk.finish_reason.unwrap_or_default(),
                            reasoning: stream_chunk.reasoning_delta,
                        };
                        sender_for_callback
                            .blocking_send(Ok(proto_response))
                            .map_err(|send_error| format!("stream send failed: {send_error}"))
                    }),
                )
                .await;

            if let Err(llm_error) = streaming_result {
                let _ = stream_chunk_sender
                    .send(Err(Status::internal(format!(
                        "LLM streaming failed: {}",
                        llm_error.message
                    ))))
                    .await;
            }
        });

        let output_stream = tokio_stream::wrappers::ReceiverStream::new(stream_chunk_receiver);
        Ok(Response::new(Box::pin(output_stream)))
    }

    async fn health_check(
        &self,
        _request: Request<HealthCheckRequest>,
    ) -> Result<Response<HealthCheckResponse>, Status> {
        info!("gateway health check requested");
        let mut services_status = std::collections::HashMap::new();
        services_status.insert("llm".to_string(), self.llm_provider_router.has_any_providers());
        Ok(Response::new(HealthCheckResponse {
            healthy: true,
            version: "0.1.0".to_string(),
            services: services_status,
        }))
    }

    async fn register_webhook(
        &self,
        _request: Request<RegisterWebhookRequest>,
    ) -> Result<Response<RegisterWebhookResponse>, Status> {
        Err(Status::unimplemented("use triggers config instead"))
    }

    async fn unregister_webhook(
        &self,
        _request: Request<UnregisterWebhookRequest>,
    ) -> Result<Response<UnregisterWebhookResponse>, Status> {
        Err(Status::unimplemented("use triggers config instead"))
    }

    async fn list_webhooks(
        &self,
        _request: Request<ListWebhooksRequest>,
    ) -> Result<Response<ListWebhooksResponse>, Status> {
        Ok(Response::new(ListWebhooksResponse { webhooks: vec![] }))
    }

    type StreamWebhookEventsStream =
        Pin<Box<dyn Stream<Item = Result<StreamWebhookEventsResponse, Status>> + Send>>;

    async fn stream_webhook_events(
        &self,
        _request: Request<StreamWebhookEventsRequest>,
    ) -> Result<Response<Self::StreamWebhookEventsStream>, Status> {
        Err(Status::unimplemented("use triggers config instead"))
    }
}
