mod proto;
mod cron;
mod watcher;
mod grpc;
mod db;
mod daemon;
mod llm;
mod orchestrator;
mod services;
mod notifications;
mod triggers;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::broadcast;
use tokio::signal;
use tonic::transport::Server;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use daemon::config::DaemonConfig;
use proto::agent::v1::agent_chat_service_server::AgentChatServiceServer;
use proto::agent::v1::daemon_service_server::DaemonServiceServer;
use proto::agent::v1::scheduler_service_server::SchedulerServiceServer;
use proto::agent::v1::worker_service_server::WorkerServiceServer;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // -----------------------------------------------------------------------
    // 1. Initialize tracing/logging
    // -----------------------------------------------------------------------
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("kraken_daemon=info".parse()?),
        )
        .init();

    info!("kraken daemon starting");

    // -----------------------------------------------------------------------
    // 2. Check if another daemon is already running
    // -----------------------------------------------------------------------
    if let Some(existing_daemon_pid) = daemon::is_daemon_running() {
        error!(
            pid = existing_daemon_pid,
            "another daemon instance is already running"
        );
        return Err(format!(
            "daemon already running with PID {existing_daemon_pid}"
        ).into());
    }

    // -----------------------------------------------------------------------
    // 3. Parse --config= argument if present
    // -----------------------------------------------------------------------
    let command_line_config_path: Option<PathBuf> = std::env::args()
        .find(|argument| argument.starts_with("--config="))
        .map(|argument| PathBuf::from(argument.trim_start_matches("--config=")));

    // -----------------------------------------------------------------------
    // 4. Load DaemonConfig
    // -----------------------------------------------------------------------
    let daemon_config = DaemonConfig::load(
        command_line_config_path.as_deref(),
    ).map_err(|config_error| {
        error!(error = %config_error, "failed to load configuration");
        config_error
    })?;

    info!(?daemon_config, "configuration loaded");

    // -----------------------------------------------------------------------
    // 5. Determine the daemon port from env or config
    // -----------------------------------------------------------------------
    let daemon_port = std::env::var("DAEMON_PORT")
        .ok()
        .and_then(|port_string| port_string.parse::<u16>().ok())
        .unwrap_or(daemon_config.services.daemon_port);

    let daemon_listen_address = format!("0.0.0.0:{daemon_port}").parse()?;

    // -----------------------------------------------------------------------
    // 6. Write PID file
    // -----------------------------------------------------------------------
    let _pid_file_path = daemon::write_pid_file().map_err(|pid_error| {
        error!(error = %pid_error, "failed to write PID file");
        pid_error
    })?;

    // -----------------------------------------------------------------------
    // 7. Create DaemonState (opens database, creates TaskStore)
    // -----------------------------------------------------------------------
    let daemon_state = daemon::DaemonState::new(daemon_config.clone())
        .map_err(|state_error| {
            error!(error = %state_error, "failed to create daemon state");
            daemon::remove_pid_file();
            state_error
        })?;

    let shared_task_store = Arc::clone(&daemon_state.task_store);
    let shutdown_receiver_for_orchestrator = daemon_state.shutdown_receiver.clone();

    // -----------------------------------------------------------------------
    // 8. Create broadcast channels for events
    // -----------------------------------------------------------------------
    let (scheduler_event_sender, _scheduler_event_receiver) = broadcast::channel(1024);
    let (activity_event_sender, _activity_event_receiver) = broadcast::channel(256);

    // -----------------------------------------------------------------------
    // 9. Create and start CronEngine and FileWatcherEngine
    // -----------------------------------------------------------------------
    let cron_engine = Arc::new(cron::CronEngine::new(scheduler_event_sender.clone()));
    cron_engine.start();

    let file_watcher_engine = Arc::new(
        watcher::FileWatcherEngine::new(scheduler_event_sender.clone()),
    );

    // -----------------------------------------------------------------------
    // 9b. Parse trigger configs and create TriggerEngine
    // -----------------------------------------------------------------------
    let parsed_webhook_trigger_configs = daemon_config
        .triggers
        .into_parsed_webhook_trigger_configs();
    let parsed_cron_trigger_configs = daemon_config
        .triggers
        .into_parsed_cron_trigger_configs();
    let parsed_watcher_trigger_configs = daemon_config
        .triggers
        .into_parsed_watcher_trigger_configs();

    info!(
        cron_triggers = parsed_cron_trigger_configs.len(),
        webhook_triggers = parsed_webhook_trigger_configs.len(),
        watcher_triggers = parsed_watcher_trigger_configs.len(),
        "trigger configs parsed from configuration"
    );

    let trigger_engine = Arc::new(triggers::engine::TriggerEngine::new(
        Arc::clone(&shared_task_store),
        parsed_webhook_trigger_configs.clone(),
        parsed_cron_trigger_configs.clone(),
        parsed_watcher_trigger_configs.clone(),
    ));

    // Register cron jobs from config into CronEngine
    for cron_trigger_config in &parsed_cron_trigger_configs {
        match cron_engine.register(
            cron_trigger_config.name.clone(),
            &cron_trigger_config.expression,
            cron_trigger_config.task_template.clone(),
            std::collections::HashMap::new(),
        ) {
            Ok((registered_cron_id, next_run_time)) => {
                info!(
                    cron_name = %cron_trigger_config.name,
                    cron_id = %registered_cron_id,
                    next_run = %next_run_time,
                    "registered cron trigger from config"
                );
            }
            Err(registration_error) => {
                warn!(
                    cron_name = %cron_trigger_config.name,
                    expression = %cron_trigger_config.expression,
                    error = %registration_error,
                    "failed to register cron trigger from config, skipping"
                );
            }
        }
    }

    // Start CronTriggerListener to bridge scheduler events to TriggerEngine
    let cron_trigger_listener = triggers::cron_trigger::CronTriggerListener::new(
        Arc::clone(&trigger_engine),
        scheduler_event_sender.subscribe(),
    );
    let cron_trigger_shutdown_receiver = daemon_state.shutdown_receiver.clone();
    let cron_trigger_listener_handle = tokio::spawn(async move {
        cron_trigger_listener.run(cron_trigger_shutdown_receiver).await;
    });

    // Start FileWatcherTriggerListener to bridge scheduler events to TriggerEngine
    let file_watcher_trigger_listener = triggers::watcher_trigger::FileWatcherTriggerListener::new(
        Arc::clone(&trigger_engine),
        scheduler_event_sender.subscribe(),
    );
    let watcher_trigger_shutdown_receiver = daemon_state.shutdown_receiver.clone();
    let watcher_trigger_listener_handle = tokio::spawn(async move {
        file_watcher_trigger_listener.run(watcher_trigger_shutdown_receiver).await;
    });

    // Start WebhookServer if any webhook triggers are configured
    let webhook_server_handle = if !parsed_webhook_trigger_configs.is_empty() {
        let webhook_port = daemon_config.services.webhook_port;
        let webhook_shutdown_receiver = daemon_state.shutdown_receiver.clone();
        let webhook_server = triggers::webhook::WebhookServer::new(
            Arc::clone(&trigger_engine),
            parsed_webhook_trigger_configs,
        );

        info!(
            webhook_port = webhook_port,
            "starting webhook server for trigger configs"
        );

        Some(tokio::spawn(async move {
            if let Err(webhook_error) = webhook_server.start(webhook_port, webhook_shutdown_receiver).await {
                error!(
                    error = %webhook_error,
                    "webhook server failed"
                );
            }
        }))
    } else {
        None
    };

    // -----------------------------------------------------------------------
    // 9c. Build notification dispatcher from config
    // -----------------------------------------------------------------------
    let notification_dispatcher = daemon_config.notifications.build_dispatcher();
    info!(
        notification_channel_count = notification_dispatcher.channel_count(),
        "notification dispatcher built from configuration"
    );
    let shared_notification_dispatcher = Arc::new(notification_dispatcher);

    // -----------------------------------------------------------------------
    // 10. Find the worker script path
    // -----------------------------------------------------------------------
    let worker_script_candidates = vec![
        "apps/core/src/worker/index.ts",
        "../core/src/worker/index.ts",
    ];

    let worker_script_path = worker_script_candidates
        .iter()
        .find(|candidate_path| std::path::Path::new(candidate_path).exists())
        .map(|found_path| found_path.to_string())
        .unwrap_or_else(|| {
            warn!(
                candidates = ?worker_script_candidates,
                "worker script not found, using default path"
            );
            "apps/core/src/worker/index.ts".to_string()
        });

    info!(worker_script_path = %worker_script_path, "worker script resolved");

    // -----------------------------------------------------------------------
    // 11. Create Orchestrator and spawn it in a tokio task
    // -----------------------------------------------------------------------
    let daemon_grpc_url = format!("http://localhost:{daemon_port}");

    let orchestrator_instance = orchestrator::Orchestrator::new(
        Arc::clone(&shared_task_store),
        daemon_config.orchestrator.max_concurrent_tasks,
        daemon_config.orchestrator.heartbeat_timeout_seconds,
        daemon_config.orchestrator.retry.max_retries,
        daemon_config.orchestrator.retry.backoff_seconds,
        daemon_grpc_url,
        worker_script_path,
        daemon_config.repo.clone(),
        daemon_config.git.branch_prefix.clone(),
        shutdown_receiver_for_orchestrator,
        Arc::clone(&shared_notification_dispatcher),
    );

    let orchestrator_heartbeat_tracker = orchestrator_instance.get_heartbeat_tracker();

    // Orchestrator::run() requires &mut self (for watch::Receiver::changed()),
    // so we wrap it in a tokio Mutex to share between the spawned run loop and
    // the DaemonService (which queries active_worker_count). The Mutex is held
    // for the lifetime of the run loop; DaemonService uses a separate query-only
    // Orchestrator instance as a workaround for Phase 1.
    let shared_orchestrator = Arc::new(tokio::sync::Mutex::new(orchestrator_instance));
    let orchestrator_for_run_loop = Arc::clone(&shared_orchestrator);

    let orchestrator_join_handle = tokio::spawn(async move {
        let mut orchestrator_guard = orchestrator_for_run_loop.lock().await;
        orchestrator_guard.run().await;
    });

    // -----------------------------------------------------------------------
    // 12. Initialize LLM provider router and create WorkerServiceImplementation
    // -----------------------------------------------------------------------
    let llm_provider_router = Arc::new(
        match llm::router::LlmProviderRouter::from_environment() {
            Ok(router) => {
                info!(
                    default_provider = %router.default_provider_name(),
                    available_providers = ?router.available_providers(),
                    "LLM provider router initialized"
                );
                router
            }
            Err(no_providers_error) => {
                warn!(
                    error = %no_providers_error,
                    "no LLM providers configured -- daemon will start but \
                     workers will fail on completion requests until API keys \
                     are set and the daemon is restarted"
                );
                llm::router::LlmProviderRouter::empty()
            }
        },
    );

    let worker_service_implementation = services::worker_service::WorkerServiceImplementation::new(
        Arc::clone(&shared_task_store),
        orchestrator_heartbeat_tracker,
        Arc::clone(&llm_provider_router),
        activity_event_sender.clone(),
    );

    // -----------------------------------------------------------------------
    // 13. Create DaemonServiceImplementation
    // -----------------------------------------------------------------------
    // DaemonServiceImplementation requires Arc<Orchestrator> for querying
    // active_worker_count. Since the real orchestrator is behind a Mutex in
    // the run loop, we create a separate query-only instance. In Phase 1,
    // this will report 0 active workers; a future refactor will expose the
    // shared DashMap directly.
    let query_only_orchestrator = Arc::new(orchestrator::Orchestrator::new(
        Arc::clone(&shared_task_store),
        daemon_config.orchestrator.max_concurrent_tasks,
        daemon_config.orchestrator.heartbeat_timeout_seconds,
        daemon_config.orchestrator.retry.max_retries,
        daemon_config.orchestrator.retry.backoff_seconds,
        format!("http://localhost:{daemon_port}"),
        String::new(),
        daemon_config.repo.clone(),
        daemon_config.git.branch_prefix.clone(),
        daemon_state.shutdown_receiver.clone(),
        Arc::clone(&shared_notification_dispatcher),
    ));

    let llm_providers_are_configured = llm_provider_router.has_any_providers();

    let daemon_service_implementation =
        services::daemon_service::DaemonServiceImplementation::new(
            Arc::clone(&shared_task_store),
            query_only_orchestrator,
            daemon_state.start_time,
            daemon_config.orchestrator.max_concurrent_tasks,
            activity_event_sender.clone(),
            llm_providers_are_configured,
        );

    // -----------------------------------------------------------------------
    // 14. Create AgentChatServiceImplementation
    // -----------------------------------------------------------------------
    let agent_chat_service_implementation =
        services::chat_service::AgentChatServiceImplementation::new(
            Arc::clone(&shared_task_store),
            activity_event_sender.clone(),
        );

    // -----------------------------------------------------------------------
    // 15. Build tonic Server with all services
    // -----------------------------------------------------------------------
    let scheduler_grpc_server = grpc::SchedulerServer::new(
        cron_engine.clone(),
        file_watcher_engine,
        scheduler_event_sender,
    );

    info!(
        port = daemon_port,
        "daemon gRPC server starting"
    );

    // -----------------------------------------------------------------------
    // 16. Serve with shutdown signal (ctrl_c)
    // -----------------------------------------------------------------------
    Server::builder()
        .add_service(SchedulerServiceServer::new(scheduler_grpc_server))
        .add_service(WorkerServiceServer::new(worker_service_implementation))
        .add_service(DaemonServiceServer::new(daemon_service_implementation))
        .add_service(AgentChatServiceServer::new(agent_chat_service_implementation))
        .serve_with_shutdown(daemon_listen_address, async {
            signal::ctrl_c().await.ok();
            info!("received shutdown signal (ctrl+c)");
        })
        .await?;

    // -----------------------------------------------------------------------
    // 17. Graceful shutdown sequence
    // -----------------------------------------------------------------------
    info!("beginning graceful shutdown");

    // Send shutdown signal to all subsystems via the watch channel
    let _ = daemon_state.shutdown_sender.send(true);

    // Wait for the orchestrator task to finish (it will kill all workers)
    if let Err(orchestrator_join_error) = orchestrator_join_handle.await {
        error!(
            error = %orchestrator_join_error,
            "orchestrator task panicked during shutdown"
        );
    }

    // Wait for trigger listeners to finish
    if let Err(cron_listener_join_error) = cron_trigger_listener_handle.await {
        error!(
            error = %cron_listener_join_error,
            "cron trigger listener task panicked during shutdown"
        );
    }

    if let Err(watcher_listener_join_error) = watcher_trigger_listener_handle.await {
        error!(
            error = %watcher_listener_join_error,
            "file watcher trigger listener task panicked during shutdown"
        );
    }

    if let Some(webhook_handle) = webhook_server_handle {
        if let Err(webhook_join_error) = webhook_handle.await {
            error!(
                error = %webhook_join_error,
                "webhook server task panicked during shutdown"
            );
        }
    }

    // Shutdown cron engine
    cron_engine.shutdown();

    // Remove PID file
    daemon::remove_pid_file();

    info!("daemon stopped");

    Ok(())
}
