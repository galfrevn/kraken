use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{error, info, warn};

use super::config::DaemonConfig;
use crate::cron::CronEngine;
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

    let reloaded_daemon_config = match DaemonConfig::load(
        configuration_file_path.map(|path| path.as_path()),
    ) {
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
        .into_parsed_cron_trigger_configs();
    let reloaded_webhook_trigger_configs = reloaded_daemon_config
        .triggers
        .into_parsed_webhook_trigger_configs();
    let reloaded_watcher_trigger_configs = reloaded_daemon_config
        .triggers
        .into_parsed_watcher_trigger_configs();

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

    trigger_engine.update_configs(
        reloaded_webhook_trigger_configs.clone(),
        reloaded_cron_trigger_configs.clone(),
        reloaded_watcher_trigger_configs.clone(),
    ).await;

    let reloaded_notification_dispatcher = reloaded_daemon_config
        .notifications
        .build_dispatcher();
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
