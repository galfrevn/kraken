mod proto;
mod cron;
mod watcher;
mod grpc;
mod db;
mod daemon;
mod llm;
mod orchestrator;
mod services;
mod triggers;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::broadcast;
use tokio::signal;
use tonic::transport::Server;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use daemon::config::DaemonConfig;
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
        daemon_grpc_url,
        worker_script_path,
        daemon_config.repo.clone(),
        shutdown_receiver_for_orchestrator,
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
        format!("http://localhost:{daemon_port}"),
        String::new(),
        daemon_config.repo.clone(),
        daemon_state.shutdown_receiver.clone(),
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
    // 14. Build tonic Server with all three services
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
    // 15. Serve with shutdown signal (ctrl_c)
    // -----------------------------------------------------------------------
    Server::builder()
        .add_service(SchedulerServiceServer::new(scheduler_grpc_server))
        .add_service(WorkerServiceServer::new(worker_service_implementation))
        .add_service(DaemonServiceServer::new(daemon_service_implementation))
        .serve_with_shutdown(daemon_listen_address, async {
            signal::ctrl_c().await.ok();
            info!("received shutdown signal (ctrl+c)");
        })
        .await?;

    // -----------------------------------------------------------------------
    // 16. Graceful shutdown sequence
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

    // Shutdown cron engine
    cron_engine.shutdown();

    // Remove PID file
    daemon::remove_pid_file();

    info!("daemon stopped");

    Ok(())
}
