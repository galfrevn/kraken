use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;
use tokio_stream::Stream;
use tonic::{Request, Response, Status, Streaming};
use tracing::{error, info, warn};

use crate::db::tasks::TaskStore;
use crate::proto::agent::v1::{
    agent_chat_service_server::AgentChatService,
    ChatInput, ChatOutput,
    chat_input::Input as ChatInputVariant,
    chat_output::Output as ChatOutputVariant,
};

use super::worker_service::WorkerActivityEvent;

pub struct AgentChatServiceImplementation {
    task_store: Arc<TaskStore>,
    activity_event_sender: broadcast::Sender<WorkerActivityEvent>,
}

impl AgentChatServiceImplementation {
    pub fn new(
        task_store: Arc<TaskStore>,
        activity_event_sender: broadcast::Sender<WorkerActivityEvent>,
    ) -> Self {
        Self {
            task_store,
            activity_event_sender,
        }
    }
}

fn build_text_delta_output(text: String) -> ChatOutput {
    ChatOutput {
        output: Some(ChatOutputVariant::TextDelta(text)),
    }
}

fn build_activity_output(activity_description: String) -> ChatOutput {
    ChatOutput {
        output: Some(ChatOutputVariant::Activity(activity_description)),
    }
}

fn build_tool_call_description_output(description: String) -> ChatOutput {
    ChatOutput {
        output: Some(ChatOutputVariant::ToolCallDescription(description)),
    }
}

fn build_tool_result_summary_output(summary: String) -> ChatOutput {
    ChatOutput {
        output: Some(ChatOutputVariant::ToolResultSummary(summary)),
    }
}

fn build_waiting_for_input_output() -> ChatOutput {
    ChatOutput {
        output: Some(ChatOutputVariant::WaitingForInput(true)),
    }
}

fn build_error_output(error_message: String) -> ChatOutput {
    ChatOutput {
        output: Some(ChatOutputVariant::Error(error_message)),
    }
}

fn build_done_output() -> ChatOutput {
    ChatOutput {
        output: Some(ChatOutputVariant::Done(true)),
    }
}

fn convert_activity_event_to_chat_output(activity_text: &str) -> ChatOutput {
    let lowercased_activity = activity_text.to_lowercase();

    if lowercased_activity.starts_with("tool_call:") || lowercased_activity.starts_with("calling tool") {
        build_tool_call_description_output(activity_text.to_string())
    } else if lowercased_activity.starts_with("tool_result:") || lowercased_activity.starts_with("tool result") {
        build_tool_result_summary_output(activity_text.to_string())
    } else {
        build_activity_output(activity_text.to_string())
    }
}

#[tonic::async_trait]
impl AgentChatService for AgentChatServiceImplementation {
    type ChatStream = Pin<Box<dyn Stream<Item = Result<ChatOutput, Status>> + Send>>;

    async fn chat(
        &self,
        request: Request<Streaming<ChatInput>>,
    ) -> Result<Response<Self::ChatStream>, Status> {
        info!("new chat session started");

        let mut incoming_message_stream = request.into_inner();
        let task_store = Arc::clone(&self.task_store);
        let activity_event_sender = self.activity_event_sender.clone();

        let (outgoing_sender, outgoing_receiver) = tokio::sync::mpsc::channel::<Result<ChatOutput, Status>>(256);

        tokio::spawn(async move {
            loop {
                let received_input = match incoming_message_stream.message().await {
                    Ok(Some(chat_input)) => chat_input,
                    Ok(None) => {
                        info!("chat session client disconnected (stream closed)");
                        break;
                    }
                    Err(stream_error) => {
                        warn!(error = %stream_error, "chat session input stream error");
                        break;
                    }
                };

                let input_variant = match received_input.input {
                    Some(variant) => variant,
                    None => {
                        warn!("received ChatInput with no input variant set, ignoring");
                        continue;
                    }
                };

                match input_variant {
                    ChatInputVariant::UserMessage(user_message_text) => {
                        info!(message_length = user_message_text.len(), "received user message in chat session");

                        let task_creation_result = task_store
                            .create_task(
                                "chat",
                                &user_message_text,
                                1,
                            )
                            .await;

                        let created_task = match task_creation_result {
                            Ok(task) => task,
                            Err(task_creation_error) => {
                                error!(error = %task_creation_error, "failed to create task for chat message");
                                let _ = outgoing_sender
                                    .send(Ok(build_error_output(format!(
                                        "failed to create task: {task_creation_error}"
                                    ))))
                                    .await;
                                continue;
                            }
                        };

                        let created_task_id = created_task.id.clone();
                        info!(task_id = %created_task_id, "created task for chat message");

                        let mut activity_subscription = activity_event_sender.subscribe();
                        let streaming_task_id = created_task_id.clone();
                        let streaming_sender = outgoing_sender.clone();
                        let streaming_task_store = Arc::clone(&task_store);

                        tokio::spawn(async move {
                            let mut task_status_poll_interval =
                                tokio::time::interval(Duration::from_secs(1));
                            task_status_poll_interval.tick().await;

                            loop {
                                tokio::select! {
                                    received_activity = activity_subscription.recv() => {
                                        match received_activity {
                                            Ok(activity_event) => {
                                                if activity_event.task_id != streaming_task_id {
                                                    continue;
                                                }

                                                let chat_output_message = convert_activity_event_to_chat_output(
                                                    &activity_event.activity,
                                                );

                                                if streaming_sender.send(Ok(chat_output_message)).await.is_err() {
                                                    info!(
                                                        task_id = %streaming_task_id,
                                                        "chat output channel closed, stopping activity forwarding"
                                                    );
                                                    return;
                                                }
                                            }
                                            Err(broadcast::error::RecvError::Lagged(skipped_count)) => {
                                                warn!(
                                                    skipped_count = skipped_count,
                                                    task_id = %streaming_task_id,
                                                    "activity subscription lagged, some events were dropped"
                                                );
                                            }
                                            Err(broadcast::error::RecvError::Closed) => {
                                                info!(
                                                    task_id = %streaming_task_id,
                                                    "activity broadcast channel closed, stopping activity forwarding"
                                                );
                                                break;
                                            }
                                        }
                                    }
                                    _ = task_status_poll_interval.tick() => {
                                        let polled_task_state = streaming_task_store
                                            .get_task(&streaming_task_id)
                                            .await;

                                        match polled_task_state {
                                            Some(ref task) if task.status == "completed" || task.status == "failed" || task.status == "cancelled" => {
                                                break;
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }

                            let final_task_state = streaming_task_store
                                .get_task(&streaming_task_id)
                                .await;

                            match final_task_state {
                                Some(task) if task.status == "completed" => {
                                    if let Some(output_text) = task.output {
                                        let _ = streaming_sender
                                            .send(Ok(build_text_delta_output(output_text)))
                                            .await;
                                    }
                                    let _ = streaming_sender
                                        .send(Ok(build_done_output()))
                                        .await;
                                }
                                Some(task) if task.status == "failed" => {
                                    let error_text = task
                                        .error_message
                                        .unwrap_or_else(|| "task failed with unknown error".to_string());
                                    let _ = streaming_sender
                                        .send(Ok(build_error_output(error_text)))
                                        .await;
                                }
                                Some(task) if task.status == "cancelled" => {
                                    let _ = streaming_sender
                                        .send(Ok(build_error_output("task was cancelled".to_string())))
                                        .await;
                                }
                                _ => {
                                    let _ = streaming_sender
                                        .send(Ok(build_done_output()))
                                        .await;
                                }
                            }

                            let _ = streaming_sender
                                .send(Ok(build_waiting_for_input_output()))
                                .await;
                        });
                    }
                    ChatInputVariant::ConfirmationResponse(confirmation_text) => {
                        info!(
                            confirmation = %confirmation_text,
                            "received confirmation response (not yet implemented)"
                        );
                    }
                    ChatInputVariant::Cancel(should_cancel) => {
                        if should_cancel {
                            info!("received cancel request in chat session");
                            let _ = outgoing_sender
                                .send(Ok(build_error_output("cancelled by user".to_string())))
                                .await;
                        }
                    }
                }
            }
        });

        let output_stream = tokio_stream::wrappers::ReceiverStream::new(outgoing_receiver);

        Ok(Response::new(Box::pin(output_stream)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_text_delta_output_contains_expected_text() {
        let output = build_text_delta_output("hello world".to_string());
        match output.output {
            Some(ChatOutputVariant::TextDelta(text)) => assert_eq!(text, "hello world"),
            other => panic!("expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_build_activity_output_contains_expected_activity() {
        let output = build_activity_output("processing step 3".to_string());
        match output.output {
            Some(ChatOutputVariant::Activity(activity)) => assert_eq!(activity, "processing step 3"),
            other => panic!("expected Activity, got {:?}", other),
        }
    }

    #[test]
    fn test_build_tool_call_description_output_contains_expected_description() {
        let output = build_tool_call_description_output("read_file(path=/etc/hosts)".to_string());
        match output.output {
            Some(ChatOutputVariant::ToolCallDescription(description)) => {
                assert_eq!(description, "read_file(path=/etc/hosts)")
            }
            other => panic!("expected ToolCallDescription, got {:?}", other),
        }
    }

    #[test]
    fn test_build_tool_result_summary_output_contains_expected_summary() {
        let output = build_tool_result_summary_output("file read successfully, 42 lines".to_string());
        match output.output {
            Some(ChatOutputVariant::ToolResultSummary(summary)) => {
                assert_eq!(summary, "file read successfully, 42 lines")
            }
            other => panic!("expected ToolResultSummary, got {:?}", other),
        }
    }

    #[test]
    fn test_build_waiting_for_input_output_is_true() {
        let output = build_waiting_for_input_output();
        match output.output {
            Some(ChatOutputVariant::WaitingForInput(value)) => assert!(value),
            other => panic!("expected WaitingForInput(true), got {:?}", other),
        }
    }

    #[test]
    fn test_build_error_output_contains_expected_error_message() {
        let output = build_error_output("something went wrong".to_string());
        match output.output {
            Some(ChatOutputVariant::Error(error_message)) => {
                assert_eq!(error_message, "something went wrong")
            }
            other => panic!("expected Error, got {:?}", other),
        }
    }

    #[test]
    fn test_build_done_output_is_true() {
        let output = build_done_output();
        match output.output {
            Some(ChatOutputVariant::Done(value)) => assert!(value),
            other => panic!("expected Done(true), got {:?}", other),
        }
    }

    #[test]
    fn test_convert_activity_event_to_chat_output_with_tool_call_prefix() {
        let output = convert_activity_event_to_chat_output("tool_call: read_file");
        match output.output {
            Some(ChatOutputVariant::ToolCallDescription(description)) => {
                assert_eq!(description, "tool_call: read_file")
            }
            other => panic!("expected ToolCallDescription, got {:?}", other),
        }
    }

    #[test]
    fn test_convert_activity_event_to_chat_output_with_calling_tool_prefix() {
        let output = convert_activity_event_to_chat_output("Calling tool write_file with args");
        match output.output {
            Some(ChatOutputVariant::ToolCallDescription(description)) => {
                assert_eq!(description, "Calling tool write_file with args")
            }
            other => panic!("expected ToolCallDescription, got {:?}", other),
        }
    }

    #[test]
    fn test_convert_activity_event_to_chat_output_with_tool_result_prefix() {
        let output = convert_activity_event_to_chat_output("tool_result: success");
        match output.output {
            Some(ChatOutputVariant::ToolResultSummary(summary)) => {
                assert_eq!(summary, "tool_result: success")
            }
            other => panic!("expected ToolResultSummary, got {:?}", other),
        }
    }

    #[test]
    fn test_convert_activity_event_to_chat_output_with_tool_result_natural_prefix() {
        let output = convert_activity_event_to_chat_output("Tool result from read_file");
        match output.output {
            Some(ChatOutputVariant::ToolResultSummary(summary)) => {
                assert_eq!(summary, "Tool result from read_file")
            }
            other => panic!("expected ToolResultSummary, got {:?}", other),
        }
    }

    #[test]
    fn test_convert_activity_event_to_chat_output_with_generic_activity() {
        let output = convert_activity_event_to_chat_output("thinking about the problem");
        match output.output {
            Some(ChatOutputVariant::Activity(activity)) => {
                assert_eq!(activity, "thinking about the problem")
            }
            other => panic!("expected Activity, got {:?}", other),
        }
    }

    #[test]
    fn test_convert_activity_event_to_chat_output_preserves_case_in_output() {
        let output = convert_activity_event_to_chat_output("Tool_Call: UPPERCASE_TOOL");
        match output.output {
            Some(ChatOutputVariant::ToolCallDescription(description)) => {
                assert_eq!(description, "Tool_Call: UPPERCASE_TOOL")
            }
            other => panic!("expected ToolCallDescription, got {:?}", other),
        }
    }
}
