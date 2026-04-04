mod channels;
mod cli;
mod cron;
mod daemon;
mod db;
mod events;
mod http_api;
mod memory_api;
mod notifications;
mod orchestrator;
mod rate_limiter;
mod triggers;
mod types;
mod watcher;

use clap::Parser;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let parsed_cli = cli::Cli::parse();
    let json_mode = parsed_cli.json;

    // SAFETY: set_var must happen before any threads are spawned.
    // At this point we are still single-threaded (before tokio runtime starts work).
    if parsed_cli.verbose && std::env::var("RUST_LOG").is_err() {
        unsafe {
            std::env::set_var("RUST_LOG", "kraken_daemon=debug");
        }
    }

    match parsed_cli.command {
        None | Some(cli::Commands::Start { .. }) => {
            let (no_daemon, dev) = match parsed_cli.command {
                Some(cli::Commands::Start { no_daemon, dev }) => (no_daemon, dev),
                _ => (false, false),
            };
            cli::start::execute(no_daemon, dev).await
        }
        Some(cli::Commands::Daemon(daemon_command)) => match daemon_command {
            cli::DaemonCommands::Start { config, port } => {
                cli::daemon_cmd::execute_background(config, port, json_mode).await
            }
            cli::DaemonCommands::Run {
                config,
                log_file,
                port,
            } => {
                cli::daemon_cmd::execute(cli::daemon_cmd::DaemonOptions {
                    config_path: config,
                    log_file,
                    port,
                })
                .await
            }
            cli::DaemonCommands::Stop { force } => cli::stop::execute(force, json_mode).await,
            cli::DaemonCommands::Status => cli::status::execute(json_mode).await,
            cli::DaemonCommands::Reload => {
                cli::config_cmd::execute(cli::ConfigCommands::Reload, json_mode).await
            }
        },
        Some(cli::Commands::Init { defaults }) => cli::init::execute(defaults, json_mode).await,
        Some(cli::Commands::Config(config_command)) => {
            cli::config_cmd::execute(config_command, json_mode).await
        }
        Some(cli::Commands::Task(task_command)) => {
            cli::task_cmd::execute(task_command, json_mode).await
        }
        Some(cli::Commands::Trigger(trigger_command)) => {
            cli::trigger_cmd::execute(trigger_command, json_mode).await
        }
        Some(cli::Commands::Notification(notification_command)) => {
            cli::notification_cmd::execute(notification_command, json_mode).await
        }
        Some(cli::Commands::Channel(channel_command)) => {
            cli::channel_cmd::execute(channel_command, json_mode).await
        }
        Some(cli::Commands::Pairing(pairing_command)) => {
            cli::channel_cmd::execute_pairing(pairing_command, json_mode).await
        }
        Some(cli::Commands::Users(users_command)) => {
            cli::channel_cmd::execute_users(users_command, json_mode).await
        }
        Some(cli::Commands::Mcp(mcp_command)) => {
            cli::mcp_cmd::execute(mcp_command, json_mode).await
        }
        Some(cli::Commands::Provider(provider_command)) => {
            cli::provider_cmd::execute(provider_command, json_mode).await
        }
        Some(cli::Commands::Audit {
            session,
            file,
            event_type,
            since,
            summary,
            limit,
        }) => {
            cli::audit_cmd::execute(session, file, event_type, since, summary, limit, json_mode)
                .await
        }
        Some(cli::Commands::Doctor { fix }) => cli::doctor::execute(fix, json_mode).await,
        Some(cli::Commands::SetupPath) => {
            print_setup_path_instructions();
            Ok(())
        }
        Some(cli::Commands::Stats { period }) => cli::stats_cmd::execute(&period, json_mode).await,
        Some(cli::Commands::Logs { follow, lines }) => {
            cli::logs_cmd::execute(follow, lines, json_mode).await
        }
        Some(cli::Commands::Clean {
            worktrees,
            tasks,
            dry_run,
        }) => cli::clean_cmd::execute(worktrees, tasks, dry_run, json_mode).await,
        Some(cli::Commands::Uninstall { keep_global, yes }) => {
            cli::uninstall::execute(keep_global, yes, json_mode).await
        }
    }
}

fn print_setup_path_instructions() {
    use console::style;

    let kraken_bin_path = dirs_next::home_dir()
        .unwrap_or_default()
        .join(".kraken")
        .join("bin");
    let kraken_bin_display = kraken_bin_path.display();

    let current_shell = std::env::var("SHELL").unwrap_or_default();
    let (rc_file, export_line) = if current_shell.ends_with("zsh") {
        (
            "~/.zshrc",
            format!("export PATH=\"{kraken_bin_display}:$PATH\""),
        )
    } else if current_shell.ends_with("fish") {
        (
            "~/.config/fish/config.fish",
            format!("fish_add_path {kraken_bin_display}"),
        )
    } else {
        (
            "~/.bashrc",
            format!("export PATH=\"{kraken_bin_display}:$PATH\""),
        )
    };

    let export_command = format!("export PATH=\"{kraken_bin_display}:$PATH\"");
    let full_command = format!("echo '{export_line}' >> {rc_file} && source {rc_file}");

    let already_in_path = std::env::var("PATH")
        .unwrap_or_default()
        .contains(&kraken_bin_path.to_string_lossy().to_string());

    let clipboard_content = if already_in_path {
        &export_command
    } else {
        &full_command
    };

    let copied = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "printf '%s' '{}' | pbcopy",
            clipboard_content.replace('\'', "'\\''")
        ))
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    if already_in_path {
        if copied {
            println!(
                "{} Already in your PATH. Copied {} to clipboard for other terminals.",
                style("✓").green().bold(),
                style(&export_command).cyan()
            );
        } else {
            println!(
                "{} Already in your PATH. Run this in other terminals:\n\n  {}",
                style("✓").green().bold(),
                style(&export_command).bold()
            );
        }
    } else if copied {
        println!(
            "{} Copied to clipboard. Paste and run in your terminal:\n\n  {}",
            style("✓").green().bold(),
            style(&full_command).bold()
        );
    } else {
        println!(
            "Run this in your terminal:\n\n  {}",
            style(&full_command).bold()
        );
    }
}

pub async fn run_daemon() -> Result<(), Box<dyn std::error::Error>> {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use std::sync::atomic::AtomicU32;

    use tokio::signal;
    use tokio::sync::broadcast;
    use tracing::{error, info, warn};
    use tracing_subscriber::EnvFilter;

    use daemon::config::DaemonConfig;
    use daemon::reload::ReloadableNotificationDispatcher;

    // SAFETY: Load .env variables before any async tasks are spawned.
    // set_var is unsafe in multi-threaded contexts, but at this point the
    // tokio runtime is running only the current task on the main thread.
    let dotenv_path = std::env::var("DOTENV_PATH")
        .ok()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs_next::home_dir()
                .unwrap_or_default()
                .join(".kraken")
                .join(".env")
        });
    if dotenv_path.exists()
        && let Ok(contents) = std::fs::read_to_string(&dotenv_path)
    {
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = trimmed.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                if std::env::var(key).is_err() {
                    unsafe {
                        std::env::set_var(key, value);
                    }
                }
            }
        }
    }

    let log_file_path = std::env::var("KRAKEN_DAEMON_LOG_FILE").ok();
    let tracing_filter = EnvFilter::from_default_env().add_directive("kraken=info".parse()?);

    if let Some(ref log_path) = log_file_path {
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)?;
        let line_buffered_writer = std::io::LineWriter::new(log_file);
        let writer_mutex = std::sync::Mutex::new(line_buffered_writer);
        tracing_subscriber::fmt()
            .with_env_filter(tracing_filter)
            .with_ansi(false)
            .with_writer(writer_mutex)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(tracing_filter)
            .init();
    }

    info!("kraken daemon starting");

    if let Some(existing_daemon_pid) = daemon::is_daemon_running() {
        error!(
            pid = existing_daemon_pid,
            "another daemon instance is already running"
        );
        return Err(format!("daemon already running with PID {existing_daemon_pid}").into());
    }

    let command_line_config_path: Option<PathBuf> =
        std::env::var("KRAKEN_CONFIG_PATH").ok().map(PathBuf::from);

    let daemon_config =
        DaemonConfig::load(command_line_config_path.as_deref()).map_err(|config_error| {
            error!(error = %config_error, "failed to load configuration");
            config_error
        })?;

    info!(?daemon_config, "configuration loaded");

    let daemon_port = std::env::var("DAEMON_PORT")
        .ok()
        .and_then(|port_string| port_string.parse::<u16>().ok())
        .unwrap_or(daemon_config.services.daemon_port);

    let _pid_file_path = daemon::write_pid_file().map_err(|pid_error| {
        error!(error = %pid_error, "failed to write PID file");
        pid_error
    })?;

    let daemon_state = daemon::DaemonState::new(daemon_config.clone()).map_err(|state_error| {
        error!(error = %state_error, "failed to create daemon state");
        daemon::remove_pid_file();
        state_error
    })?;

    let shared_task_store = Arc::clone(&daemon_state.task_store);
    let shutdown_receiver_for_orchestrator = daemon_state.shutdown_receiver.clone();

    const SCHEDULER_EVENT_CHANNEL_CAPACITY: usize = 1024;
    let (scheduler_event_sender, _scheduler_event_receiver) =
        broadcast::channel(SCHEDULER_EVENT_CHANNEL_CAPACITY);

    let cron_engine = Arc::new(cron::CronEngine::new(scheduler_event_sender.clone()));
    cron_engine.start();

    let _file_watcher_engine = Arc::new(watcher::FileWatcherEngine::new(
        scheduler_event_sender.clone(),
    ));

    let parsed_webhook_trigger_configs = daemon_config.triggers.parsed_webhook_trigger_configs();
    let parsed_cron_trigger_configs = daemon_config.triggers.parsed_cron_trigger_configs();
    let parsed_watcher_trigger_configs = daemon_config.triggers.parsed_watcher_trigger_configs();
    let parsed_slash_command_trigger_configs = daemon_config
        .triggers
        .parsed_slash_command_trigger_configs();

    info!(
        cron_triggers = parsed_cron_trigger_configs.len(),
        webhook_triggers = parsed_webhook_trigger_configs.len(),
        watcher_triggers = parsed_watcher_trigger_configs.len(),
        slash_command_triggers = parsed_slash_command_trigger_configs.len(),
        "trigger configs parsed from configuration"
    );

    let event_broadcaster = events::EventBroadcaster::new();

    let trigger_rate_limiter = Arc::new(rate_limiter::RateLimiter::new(
        daemon_config.rate_limits.tasks_per_trigger.max_events,
        daemon_config.rate_limits.tasks_per_trigger.window_minutes,
    ));

    let loop_detector = Arc::new(rate_limiter::LoopDetector::new(
        daemon_config.rate_limits.loop_detection.window_minutes,
        daemon_config.rate_limits.loop_detection.max_similar_tasks,
    ));

    let trigger_engine = Arc::new(
        triggers::engine::TriggerEngine::new(
            Arc::clone(&shared_task_store),
            parsed_webhook_trigger_configs.clone(),
            parsed_cron_trigger_configs.clone(),
            parsed_watcher_trigger_configs.clone(),
            event_broadcaster.clone(),
        )
        .with_rate_limiter(Arc::clone(&trigger_rate_limiter)),
    );

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

    for watcher_trigger_config in &parsed_watcher_trigger_configs {
        match _file_watcher_engine.register(
            watcher_trigger_config.name.clone(),
            watcher_trigger_config.paths.clone(),
            watcher_trigger_config.ignore_patterns.clone(),
            watcher_trigger_config.debounce_ms,
        ) {
            Ok(registered_watcher_id) => {
                info!(
                    watcher_name = %watcher_trigger_config.name,
                    watcher_id = %registered_watcher_id,
                    "registered file watcher trigger from config"
                );
            }
            Err(registration_error) => {
                warn!(
                    watcher_name = %watcher_trigger_config.name,
                    error = %registration_error,
                    "failed to register file watcher trigger from config, skipping"
                );
            }
        }
    }

    let cron_trigger_listener = triggers::cron_trigger::CronTriggerListener::new(
        Arc::clone(&trigger_engine),
        scheduler_event_sender.subscribe(),
    );
    let cron_trigger_shutdown_receiver = daemon_state.shutdown_receiver.clone();
    let cron_trigger_listener_handle = tokio::spawn(async move {
        cron_trigger_listener
            .run(cron_trigger_shutdown_receiver)
            .await;
    });

    let file_watcher_trigger_listener = triggers::watcher_trigger::FileWatcherTriggerListener::new(
        Arc::clone(&trigger_engine),
        scheduler_event_sender.subscribe(),
    );
    let watcher_trigger_shutdown_receiver = daemon_state.shutdown_receiver.clone();
    let watcher_trigger_listener_handle = tokio::spawn(async move {
        file_watcher_trigger_listener
            .run(watcher_trigger_shutdown_receiver)
            .await;
    });

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
            if let Err(webhook_error) = webhook_server
                .start(webhook_port, webhook_shutdown_receiver)
                .await
            {
                error!(
                    error = %webhook_error,
                    "webhook server failed"
                );
            }
        }))
    } else {
        None
    };

    if !parsed_slash_command_trigger_configs.is_empty() {
        warn!(
            count = parsed_slash_command_trigger_configs.len(),
            "slash command triggers are configured but not yet supported, skipping"
        );
    }

    let shared_channel_router_handle: Arc<
        tokio::sync::RwLock<Option<Arc<channels::router::ChannelRouterHandle>>>,
    > = Arc::new(tokio::sync::RwLock::new(None));

    let mut notification_dispatcher = daemon_config.notifications.build_dispatcher();
    notification_dispatcher.add_channel(Box::new(
        notifications::channel_reply::ChannelReplyNotificationChannel::new(Arc::clone(
            &shared_channel_router_handle,
        )),
    ));
    info!(
        notification_channel_count = notification_dispatcher.channel_count(),
        "notification dispatcher built from configuration"
    );
    let reloadable_notification_dispatcher = Arc::new(ReloadableNotificationDispatcher::new(
        notification_dispatcher,
    ));
    let shared_notification_dispatcher = reloadable_notification_dispatcher
        .current_dispatcher()
        .await;

    // Initialize channel user store (shared across channel router and reload)
    let channel_user_store = Arc::new(db::channel_users::ChannelUserStore::new(Arc::clone(
        &daemon_state.database_pool,
    )));
    if let Err(init_error) = channel_user_store.initialize().await {
        error!(error = %init_error, "failed to initialize channel users tables");
        return Err(format!("failed to initialize channel users: {init_error}").into());
    }

    // Migrate legacy owner_id to channel_authorized_users
    if let Some(telegram_config) = &daemon_config.channels.telegram
        && let Some(owner_id) = telegram_config.owner_id
        && owner_id != 0
    {
        let platform_id = owner_id.to_string();
        match channel_user_store
            .is_authorized("telegram", &platform_id)
            .await
        {
            Ok(false) => {
                match channel_user_store
                    .authorize_user("telegram", &platform_id, None, "migration")
                    .await
                {
                    Ok(_) => {
                        info!(
                            owner_id = owner_id,
                            "migrated legacy ownerId to authorized users"
                        );
                    }
                    Err(err) => {
                        warn!(error = %err, "failed to migrate legacy ownerId");
                    }
                }
            }
            Ok(true) => { /* already migrated */ }
            Err(err) => {
                warn!(error = %err, "failed to check owner_id migration status");
            }
        }
    }

    // Spawn periodic cleanup of expired pairing requests (every 10 minutes)
    let cleanup_shutdown_receiver = daemon_state.shutdown_receiver.clone();
    let cleanup_task_handle = {
        let cleanup_store = Arc::clone(&channel_user_store);
        let mut shutdown_rx = cleanup_shutdown_receiver;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(600));
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if let Err(err) = cleanup_store.cleanup_expired().await {
                            warn!(error = %err, "failed to cleanup expired pairing requests");
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        info!("pairing cleanup task shutting down");
                        break;
                    }
                }
            }
        })
    };

    if daemon_config.channels.has_any_enabled() {
        let channel_session_store = Arc::new(db::channel_sessions::ChannelSessionStore::new(
            Arc::clone(&daemon_state.database_pool),
        ));
        if let Err(init_error) = channel_session_store.initialize().await {
            error!(error = %init_error, "failed to initialize channel sessions table");
            return Err(format!("failed to initialize channel sessions: {init_error}").into());
        } else {
            let channel_worker_script_candidates = [
                "apps/app/src/channel-worker.ts",
                "../app/src/channel-worker.ts",
                "src/channel-worker.ts",
            ];
            let channel_worker_script_path = channel_worker_script_candidates
                .iter()
                .find(|path| std::path::Path::new(path).exists())
                .map(|path| path.to_string())
                .unwrap_or_else(|| "apps/app/src/channel-worker.ts".to_string());

            let channel_worker_manager =
                Arc::new(channels::worker_manager::ChannelWorkerManager::new(
                    channel_worker_script_path,
                    format!("http://localhost:{daemon_port}"),
                    ".".to_string(),
                    daemon_config.channels.worker_port,
                ));

            let mut channel_router = channels::router::ChannelRouter::new(
                channel_session_store,
                Arc::clone(&channel_worker_manager),
                event_broadcaster.clone(),
            )
            .with_command_context(Arc::clone(&channel_user_store), daemon_port);

            if let Some(telegram_config) = daemon_config.channels.resolved_telegram() {
                let allow_from = telegram_config.effective_allow_from();
                let telegram_adapter = channels::telegram::TelegramAdapter::new(
                    telegram_config.token,
                    telegram_config.dm_policy,
                    allow_from,
                )
                .with_user_store(Arc::clone(&channel_user_store));
                channel_router.add_adapter(Box::new(telegram_adapter));
            }

            if let Some(discord_config) = daemon_config.channels.resolved_discord() {
                let discord_adapter = channels::discord::DiscordAdapter::new(
                    discord_config.token,
                    discord_config.dm_policy,
                    discord_config.allow_from,
                    discord_config.allowed_channels,
                )
                .with_user_store(Arc::clone(&channel_user_store));
                channel_router.add_adapter(Box::new(discord_adapter));
            }

            match channel_router.start().await {
                Ok(handle) => {
                    info!("channel router started");
                    *shared_channel_router_handle.write().await = Some(handle);
                }
                Err(start_error) => {
                    error!(error = %start_error, "failed to start channel router");
                }
            }
        }
    } else {
        info!("no channels configured, skipping channel router");
    }

    let reload_handle = Arc::new(daemon::reload::ReloadHandle::new(
        Arc::clone(&reloadable_notification_dispatcher),
        Arc::clone(&cron_engine),
        Arc::clone(&_file_watcher_engine),
        Arc::clone(&trigger_engine),
        command_line_config_path.clone(),
        daemon_config.clone(),
        daemon_state.database_pool.clone(),
        event_broadcaster.clone(),
        daemon_port,
        Arc::clone(&shared_channel_router_handle),
        Arc::clone(&channel_user_store),
    ));

    let worker_script_candidates = vec!["apps/app/src/worker.ts", "../app/src/worker.ts"];

    let worker_script_path = worker_script_candidates
        .iter()
        .find(|candidate_path| std::path::Path::new(candidate_path).exists())
        .map(|found_path| {
            std::fs::canonicalize(found_path)
                .map(|absolute| absolute.to_string_lossy().to_string())
                .unwrap_or_else(|_| found_path.to_string())
        })
        .unwrap_or_else(|| {
            warn!(
                candidates = ?worker_script_candidates,
                "worker script not found, using default path"
            );
            "apps/app/src/worker.ts".to_string()
        });

    info!(worker_script_path = %worker_script_path, "worker script resolved");

    // Shared atomic counter that the orchestrator increments/decrements as
    // workers start and finish.  Passed to the HTTP API so /api/status can
    // report live worker counts without holding a lock.
    let shared_active_worker_count = Arc::new(AtomicU32::new(0));

    let daemon_http_url = format!("http://localhost:{daemon_port}");

    let orchestrator_instance = orchestrator::Orchestrator::new(
        Arc::clone(&shared_task_store),
        daemon_config.orchestrator.max_concurrent_tasks,
        daemon_config.orchestrator.heartbeat_timeout_seconds,
        daemon_config.orchestrator.retry.max_retries,
        daemon_config.orchestrator.retry.backoff_seconds,
        daemon_http_url,
        worker_script_path,
        daemon_config.git.branch_prefix.clone(),
        shutdown_receiver_for_orchestrator,
        Arc::clone(&shared_notification_dispatcher),
        daemon_config.costs.cost_warning_threshold_usd,
        event_broadcaster.clone(),
    );

    let shared_heartbeat_tracker = orchestrator_instance.get_heartbeat_tracker();
    let shared_orchestrator = Arc::new(tokio::sync::Mutex::new(orchestrator_instance));
    let orchestrator_for_run_loop = Arc::clone(&shared_orchestrator);

    let orchestrator_join_handle = tokio::spawn(async move {
        let mut orchestrator_guard = orchestrator_for_run_loop.lock().await;
        orchestrator_guard.run().await;
    });

    #[cfg(unix)]
    {
        let sighup_reload_handle = Arc::clone(&reload_handle);
        tokio::spawn(async move {
            use tokio::signal::unix::{SignalKind, signal};
            let mut sighup_signal_stream = match signal(SignalKind::hangup()) {
                Ok(stream) => stream,
                Err(e) => {
                    warn!(error = %e, "failed to register SIGHUP handler, hot-reload disabled");
                    return;
                }
            };
            loop {
                sighup_signal_stream.recv().await;
                info!("SIGHUP received, reloading configuration");
                match sighup_reload_handle.reload().await {
                    Ok((_, changes)) => {
                        info!(
                            change_count = changes.len(),
                            "configuration reloaded via SIGHUP"
                        );
                    }
                    Err(reload_error) => {
                        error!(error = %reload_error, "configuration reload failed after SIGHUP");
                    }
                }
            }
        });
        info!("SIGHUP hot-reload handler registered");
    }

    #[cfg(not(unix))]
    {
        info!("SIGHUP hot-reload not available on this platform");
    }

    {
        let config_watcher_reload_handle = Arc::clone(&reload_handle);
        let config_file_path =
            DaemonConfig::resolve_config_path(command_line_config_path.as_deref());
        let mut config_watcher_shutdown = daemon_state.shutdown_receiver.clone();

        tokio::spawn(async move {
            use notify::{RecommendedWatcher, RecursiveMode, Watcher};

            let (notify_sender, mut notify_receiver) = tokio::sync::mpsc::channel::<()>(4);

            let mut watcher = match RecommendedWatcher::new(
                move |result: Result<notify::Event, notify::Error>| {
                    if let Ok(event) = result
                        && event.kind.is_modify()
                    {
                        let _ = notify_sender.try_send(());
                    }
                },
                notify::Config::default(),
            ) {
                Ok(w) => w,
                Err(e) => {
                    warn!(error = %e, "failed to create config file watcher");
                    return;
                }
            };

            if let Err(e) = watcher.watch(&config_file_path, RecursiveMode::NonRecursive) {
                warn!(
                    path = %config_file_path.display(),
                    error = %e,
                    "failed to watch config file"
                );
                return;
            }

            info!(path = %config_file_path.display(), "config file watcher started");

            const DEBOUNCE_DURATION: Duration = Duration::from_millis(500);

            loop {
                tokio::select! {
                    Some(()) = notify_receiver.recv() => {
                        tokio::time::sleep(DEBOUNCE_DURATION).await;
                        while notify_receiver.try_recv().is_ok() {}

                        info!("config file changed, reloading");
                        match config_watcher_reload_handle.reload().await {
                            Ok((_, changes)) => {
                                info!(
                                    change_count = changes.len(),
                                    "configuration reloaded via file watcher"
                                );
                            }
                            Err(reload_error) => {
                                warn!(error = %reload_error, "config file watcher reload failed");
                            }
                        }
                    }
                    _ = config_watcher_shutdown.changed() => {
                        info!("config file watcher shutting down");
                        break;
                    }
                }
            }

            drop(watcher);
        });
    }

    let http_api_shutdown_receiver = daemon_state.shutdown_receiver.clone();
    let http_api_shutdown_sender = Arc::clone(&daemon_state.shutdown_sender);
    let http_api_task_store = Arc::clone(&shared_task_store);
    let http_api_active_worker_count = Arc::clone(&shared_active_worker_count);
    let http_api_daemon_start_time = daemon_state.start_time;
    let http_api_max_concurrent_workers = daemon_config.orchestrator.max_concurrent_tasks;
    let http_api_config_path = command_line_config_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());

    let http_api_memory_store = Arc::clone(&daemon_state.memory_store);

    let http_api_event_broadcaster = event_broadcaster.clone();

    let http_api_audit_store = Arc::clone(&daemon_state.audit_store);

    let reload_handle_for_shutdown = Arc::clone(&reload_handle);

    let http_api_server_handle = tokio::spawn(async move {
        if let Err(http_api_error) = http_api::start_http_api_server_with_options(
            http_api_task_store,
            daemon_port,
            http_api_shutdown_receiver,
            Some(http_api_shutdown_sender),
            Some(http_api_active_worker_count),
            http_api_max_concurrent_workers,
            Some(http_api_daemon_start_time),
            http_api_config_path,
            Some(shared_heartbeat_tracker),
            Some(http_api_memory_store),
            Some(http_api_event_broadcaster),
            Some(http_api_audit_store),
            Some(loop_detector),
            Some(Arc::clone(&reload_handle)),
            daemon_config.widget.resolved_token(),
        )
        .await
        {
            error!(
                error = %http_api_error,
                "HTTP API server failed"
            );
        }
    });

    info!(http_api_port = daemon_port, "HTTP API server spawned");

    signal::ctrl_c().await.ok();
    info!("received shutdown signal (ctrl+c)");

    info!("beginning graceful shutdown");

    let _ = daemon_state.shutdown_sender.send(true);

    if let Err(orchestrator_join_error) = orchestrator_join_handle.await {
        error!(
            error = %orchestrator_join_error,
            "orchestrator task panicked during shutdown"
        );
    }

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

    if let Some(webhook_handle) = webhook_server_handle
        && let Err(webhook_join_error) = webhook_handle.await
    {
        error!(
            error = %webhook_join_error,
            "webhook server task panicked during shutdown"
        );
    }

    if let Err(http_api_join_error) = http_api_server_handle.await {
        error!(
            error = %http_api_join_error,
            "HTTP API server task panicked during shutdown"
        );
    }

    {
        let channel_handle_guard = reload_handle_for_shutdown
            .channel_router_handle
            .read()
            .await;
        if let Some(channel_handle) = &*channel_handle_guard {
            channel_handle.shutdown().await;
            info!("channel router stopped");
        }
    }

    if let Err(cleanup_join_error) = cleanup_task_handle.await {
        error!(
            error = %cleanup_join_error,
            "pairing cleanup task panicked during shutdown"
        );
    }

    cron_engine.shutdown();

    daemon::remove_pid_file();

    info!("daemon stopped");

    Ok(())
}
