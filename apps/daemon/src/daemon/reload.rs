use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use super::config::DaemonConfig;
use crate::channels;
use crate::cron::CronEngine;
use crate::db;
use crate::db::channel_sessions::ChannelSessionStore;
use crate::events::EventBroadcaster;
use crate::notifications::dispatcher::NotificationDispatcher;
use crate::triggers::engine::TriggerEngine;
use crate::watcher::FileWatcherEngine;

pub struct ReloadableNotificationDispatcher {
    inner_dispatcher: RwLock<Arc<NotificationDispatcher>>,
}

impl ReloadableNotificationDispatcher {
    pub fn new(initial_dispatcher: NotificationDispatcher) -> Self {
        Self {
            inner_dispatcher: RwLock::new(Arc::new(initial_dispatcher)),
        }
    }

    pub async fn current_dispatcher(&self) -> Arc<NotificationDispatcher> {
        Arc::clone(&*self.inner_dispatcher.read().await)
    }

    pub async fn replace_dispatcher(&self, new_dispatcher: NotificationDispatcher) {
        let mut write_guard = self.inner_dispatcher.write().await;
        *write_guard = Arc::new(new_dispatcher);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigChange {
    pub section: String,
    pub change_type: String,
    pub detail: String,
}

pub fn diff_configs(old: &DaemonConfig, new: &DaemonConfig) -> Vec<ConfigChange> {
    let mut changes = Vec::new();

    let old_cron_names: HashSet<&str> =
        old.triggers.crons.iter().map(|c| c.name.as_str()).collect();
    let new_cron_names: HashSet<&str> =
        new.triggers.crons.iter().map(|c| c.name.as_str()).collect();
    for name in new_cron_names.difference(&old_cron_names) {
        changes.push(ConfigChange {
            section: "triggers.crons".into(),
            change_type: "added".into(),
            detail: name.to_string(),
        });
    }
    for name in old_cron_names.difference(&new_cron_names) {
        changes.push(ConfigChange {
            section: "triggers.crons".into(),
            change_type: "removed".into(),
            detail: name.to_string(),
        });
    }

    let old_watcher_names: HashSet<&str> = old
        .triggers
        .watchers
        .iter()
        .map(|w| w.name.as_str())
        .collect();
    let new_watcher_names: HashSet<&str> = new
        .triggers
        .watchers
        .iter()
        .map(|w| w.name.as_str())
        .collect();
    for name in new_watcher_names.difference(&old_watcher_names) {
        changes.push(ConfigChange {
            section: "triggers.watchers".into(),
            change_type: "added".into(),
            detail: name.to_string(),
        });
    }
    for name in old_watcher_names.difference(&new_watcher_names) {
        changes.push(ConfigChange {
            section: "triggers.watchers".into(),
            change_type: "removed".into(),
            detail: name.to_string(),
        });
    }

    let old_webhook_names: HashSet<&str> = old
        .triggers
        .webhooks
        .iter()
        .map(|w| w.name.as_str())
        .collect();
    let new_webhook_names: HashSet<&str> = new
        .triggers
        .webhooks
        .iter()
        .map(|w| w.name.as_str())
        .collect();
    for name in new_webhook_names.difference(&old_webhook_names) {
        changes.push(ConfigChange {
            section: "triggers.webhooks".into(),
            change_type: "added".into(),
            detail: name.to_string(),
        });
    }
    for name in old_webhook_names.difference(&new_webhook_names) {
        changes.push(ConfigChange {
            section: "triggers.webhooks".into(),
            change_type: "removed".into(),
            detail: name.to_string(),
        });
    }

    let old_channel_names: HashSet<&str> = old
        .notifications
        .channels
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    let new_channel_names: HashSet<&str> = new
        .notifications
        .channels
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    for name in new_channel_names.difference(&old_channel_names) {
        changes.push(ConfigChange {
            section: "notifications.channels".into(),
            change_type: "added".into(),
            detail: name.to_string(),
        });
    }
    for name in old_channel_names.difference(&new_channel_names) {
        changes.push(ConfigChange {
            section: "notifications.channels".into(),
            change_type: "removed".into(),
            detail: name.to_string(),
        });
    }

    if old.services.daemon_port != new.services.daemon_port {
        changes.push(ConfigChange {
            section: "services.daemonPort".into(),
            change_type: "modified".into(),
            detail: format!(
                "{} → {}",
                old.services.daemon_port, new.services.daemon_port
            ),
        });
    }
    if old.services.webhook_port != new.services.webhook_port {
        changes.push(ConfigChange {
            section: "services.webhookPort".into(),
            change_type: "modified".into(),
            detail: format!(
                "{} → {}",
                old.services.webhook_port, new.services.webhook_port
            ),
        });
    }

    if old.orchestrator.max_concurrent_tasks != new.orchestrator.max_concurrent_tasks {
        changes.push(ConfigChange {
            section: "orchestrator.maxConcurrentTasks".into(),
            change_type: "modified".into(),
            detail: format!(
                "{} → {}",
                old.orchestrator.max_concurrent_tasks, new.orchestrator.max_concurrent_tasks
            ),
        });
    }

    if old.git.branch_prefix != new.git.branch_prefix {
        changes.push(ConfigChange {
            section: "git.branchPrefix".into(),
            change_type: "modified".into(),
            detail: format!("{} → {}", old.git.branch_prefix, new.git.branch_prefix),
        });
    }

    let old_has_telegram = old
        .channels
        .telegram
        .as_ref()
        .map(|t| t.enabled)
        .unwrap_or(false);
    let new_has_telegram = new
        .channels
        .telegram
        .as_ref()
        .map(|t| t.enabled)
        .unwrap_or(false);

    match (old_has_telegram, new_has_telegram) {
        (false, true) => changes.push(ConfigChange {
            section: "channels.telegram".into(),
            change_type: "added".into(),
            detail: "telegram adapter".into(),
        }),
        (true, false) => changes.push(ConfigChange {
            section: "channels.telegram".into(),
            change_type: "removed".into(),
            detail: "telegram adapter".into(),
        }),
        (true, true) => {
            let old_owner = old
                .channels
                .telegram
                .as_ref()
                .map(|t| t.owner_id)
                .unwrap_or(0);
            let new_owner = new
                .channels
                .telegram
                .as_ref()
                .map(|t| t.owner_id)
                .unwrap_or(0);
            if old_owner != new_owner {
                changes.push(ConfigChange {
                    section: "channels.telegram".into(),
                    change_type: "modified".into(),
                    detail: format!("owner_id: {old_owner} → {new_owner}"),
                });
            }
        }
        _ => {}
    }

    changes
}

pub struct ReloadHandle {
    pub notification_dispatcher: Arc<ReloadableNotificationDispatcher>,
    pub cron_engine: Arc<CronEngine>,
    pub file_watcher_engine: Arc<FileWatcherEngine>,
    pub trigger_engine: Arc<TriggerEngine>,
    pub config_path: Option<PathBuf>,
    pub last_config: RwLock<DaemonConfig>,
    pub database_pool: db::DatabasePool,
    pub event_broadcaster: EventBroadcaster,
    pub daemon_port: u16,
    pub channel_router_handle: RwLock<Option<Arc<channels::router::ChannelRouterHandle>>>,
}

impl ReloadHandle {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        notification_dispatcher: Arc<ReloadableNotificationDispatcher>,
        cron_engine: Arc<CronEngine>,
        file_watcher_engine: Arc<FileWatcherEngine>,
        trigger_engine: Arc<TriggerEngine>,
        config_path: Option<PathBuf>,
        initial_config: DaemonConfig,
        database_pool: db::DatabasePool,
        event_broadcaster: EventBroadcaster,
        daemon_port: u16,
        initial_channel_router: Option<Arc<channels::router::ChannelRouterHandle>>,
    ) -> Self {
        Self {
            notification_dispatcher,
            cron_engine,
            file_watcher_engine,
            trigger_engine,
            config_path,
            last_config: RwLock::new(initial_config),
            database_pool,
            event_broadcaster,
            daemon_port,
            channel_router_handle: RwLock::new(initial_channel_router),
        }
    }

    pub async fn reload(&self) -> Result<(ReloadResult, Vec<ConfigChange>), String> {
        let new_config = DaemonConfig::load(self.config_path.as_deref())
            .map_err(|e| format!("failed to load config: {e}"))?;

        if let Err(validation_errors) = new_config.validate() {
            return Err(format!(
                "validation failed: {}",
                validation_errors.join("; ")
            ));
        }

        let old_config = self.last_config.read().await;
        let changes = diff_configs(&old_config, &new_config);
        let old_had_channels = old_config.channels.has_any_enabled();
        drop(old_config);

        let result = reload_configuration_from_disk(
            self.config_path.as_ref(),
            &self.notification_dispatcher,
            &self.cron_engine,
            &self.file_watcher_engine,
            &self.trigger_engine,
        )
        .await?;

        let channels_changed = changes.iter().any(|c| c.section.starts_with("channels."));
        let new_has_channels = new_config.channels.has_any_enabled();

        if channels_changed || (new_has_channels != old_had_channels) {
            self.reload_channels(&new_config).await;
        }

        *self.last_config.write().await = new_config;

        Ok((result, changes))
    }

    async fn reload_channels(&self, new_config: &DaemonConfig) {
        let mut handle_guard = self.channel_router_handle.write().await;

        if let Some(old_handle) = handle_guard.take() {
            info!("shutting down old channel router for reload");
            old_handle.shutdown().await;
        }

        if !new_config.channels.has_any_enabled() {
            info!("no channels enabled after reload");
            return;
        }

        let session_store = Arc::new(ChannelSessionStore::new(self.database_pool.clone()));
        if let Err(init_error) = session_store.initialize().await {
            error!(error = %init_error, "failed to initialize channel sessions during reload");
            return;
        }

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

        let worker_manager = Arc::new(channels::worker_manager::ChannelWorkerManager::new(
            channel_worker_script_path,
            format!("http://localhost:{}", self.daemon_port),
            ".".to_string(),
            new_config.channels.worker_port,
        ));

        let mut channel_router = channels::router::ChannelRouter::new(
            session_store,
            worker_manager,
            self.event_broadcaster.clone(),
        );

        if let Some(telegram_config) = new_config.channels.resolved_telegram() {
            let telegram_adapter = channels::telegram::TelegramAdapter::new(
                telegram_config.token,
                telegram_config.owner_id,
            );
            channel_router.add_adapter(Box::new(telegram_adapter));
        }

        match channel_router.start().await {
            Ok(new_handle) => {
                info!("channel router restarted after config reload");
                *handle_guard = Some(new_handle);
            }
            Err(start_error) => {
                error!(error = %start_error, "failed to restart channel router after reload");
            }
        }
    }
}

pub struct ReloadResult {
    pub cron_trigger_count: usize,
    pub webhook_trigger_count: usize,
    pub watcher_trigger_count: usize,
    pub notification_channel_count: usize,
}

pub async fn reload_configuration_from_disk(
    configuration_file_path: Option<&PathBuf>,
    reloadable_notification_dispatcher: &ReloadableNotificationDispatcher,
    cron_engine: &CronEngine,
    file_watcher_engine: &FileWatcherEngine,
    trigger_engine: &TriggerEngine,
) -> Result<ReloadResult, String> {
    info!("reloading configuration from disk");

    let reloaded_daemon_config =
        match DaemonConfig::load(configuration_file_path.map(|path| path.as_path())) {
            Ok(loaded_config) => loaded_config,
            Err(config_load_error) => {
                error!(
                    error = %config_load_error,
                    "failed to reload configuration, keeping current settings"
                );
                return Err(format!("failed to load config: {config_load_error}"));
            }
        };

    let reloaded_cron_trigger_configs = reloaded_daemon_config
        .triggers
        .parsed_cron_trigger_configs();
    let reloaded_webhook_trigger_configs = reloaded_daemon_config
        .triggers
        .parsed_webhook_trigger_configs();
    let reloaded_watcher_trigger_configs = reloaded_daemon_config
        .triggers
        .parsed_watcher_trigger_configs();

    let existing_cron_entries = cron_engine.list();
    for existing_cron_entry in &existing_cron_entries {
        cron_engine.unregister(&existing_cron_entry.cron_id);
    }
    info!(
        unregistered_count = existing_cron_entries.len(),
        "unregistered existing cron entries"
    );

    for cron_trigger_config in &reloaded_cron_trigger_configs {
        match cron_engine.register(
            cron_trigger_config.name.clone(),
            &cron_trigger_config.expression,
            cron_trigger_config.task_template.clone(),
            HashMap::new(),
        ) {
            Ok((registered_cron_id, next_run_time)) => {
                info!(
                    cron_name = %cron_trigger_config.name,
                    cron_id = %registered_cron_id,
                    next_run = %next_run_time,
                    "re-registered cron trigger from reloaded config"
                );
            }
            Err(registration_error) => {
                warn!(
                    cron_name = %cron_trigger_config.name,
                    error = %registration_error,
                    "failed to re-register cron trigger, skipping"
                );
            }
        }
    }

    let existing_watcher_entries = file_watcher_engine.list();
    for existing_watcher_entry in &existing_watcher_entries {
        file_watcher_engine.unregister(&existing_watcher_entry.watcher_id);
    }
    info!(
        unregistered_count = existing_watcher_entries.len(),
        "unregistered existing file watcher entries"
    );

    for watcher_trigger_config in &reloaded_watcher_trigger_configs {
        match file_watcher_engine.register(
            watcher_trigger_config.name.clone(),
            watcher_trigger_config.paths.clone(),
            watcher_trigger_config.ignore_patterns.clone(),
            watcher_trigger_config.debounce_ms,
        ) {
            Ok(registered_watcher_id) => {
                info!(
                    watcher_name = %watcher_trigger_config.name,
                    watcher_id = %registered_watcher_id,
                    "re-registered file watcher from reloaded config"
                );
            }
            Err(registration_error) => {
                warn!(
                    watcher_name = %watcher_trigger_config.name,
                    error = %registration_error,
                    "failed to re-register file watcher, skipping"
                );
            }
        }
    }

    trigger_engine
        .update_configs(
            reloaded_webhook_trigger_configs.clone(),
            reloaded_cron_trigger_configs.clone(),
            reloaded_watcher_trigger_configs.clone(),
        )
        .await;

    let reloaded_notification_dispatcher = reloaded_daemon_config.notifications.build_dispatcher();
    let reloaded_notification_channel_count = reloaded_notification_dispatcher.channel_count();

    reloadable_notification_dispatcher
        .replace_dispatcher(reloaded_notification_dispatcher)
        .await;

    info!(
        cron_triggers = reloaded_cron_trigger_configs.len(),
        webhook_triggers = reloaded_webhook_trigger_configs.len(),
        watcher_triggers = reloaded_watcher_trigger_configs.len(),
        notification_channels = reloaded_notification_channel_count,
        "configuration reload complete"
    );

    Ok(ReloadResult {
        cron_trigger_count: reloaded_cron_trigger_configs.len(),
        webhook_trigger_count: reloaded_webhook_trigger_configs.len(),
        watcher_trigger_count: reloaded_watcher_trigger_configs.len(),
        notification_channel_count: reloaded_notification_channel_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifications::dispatcher::NotificationDispatcher;

    #[tokio::test]
    async fn reloadable_dispatcher_returns_current_dispatcher() {
        let initial_dispatcher = NotificationDispatcher::new();
        let reloadable = ReloadableNotificationDispatcher::new(initial_dispatcher);

        let current = reloadable.current_dispatcher().await;
        assert_eq!(current.channel_count(), 0);
    }

    #[tokio::test]
    async fn reloadable_dispatcher_can_be_replaced() {
        let initial_dispatcher = NotificationDispatcher::new();
        let reloadable = ReloadableNotificationDispatcher::new(initial_dispatcher);

        assert_eq!(reloadable.current_dispatcher().await.channel_count(), 0);

        let replacement_dispatcher = NotificationDispatcher::new();
        reloadable.replace_dispatcher(replacement_dispatcher).await;

        assert_eq!(reloadable.current_dispatcher().await.channel_count(), 0);
    }
}
