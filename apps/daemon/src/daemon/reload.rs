use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{error, info};

use super::config::DaemonConfig;
use crate::notifications::dispatcher::NotificationDispatcher;

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

    #[cfg_attr(not(unix), allow(dead_code))]
    pub async fn replace_dispatcher(&self, new_dispatcher: NotificationDispatcher) {
        let mut write_guard = self.inner_dispatcher.write().await;
        *write_guard = Arc::new(new_dispatcher);
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
pub async fn reload_configuration_from_disk(
    configuration_file_path: Option<&PathBuf>,
    reloadable_notification_dispatcher: &ReloadableNotificationDispatcher,
) {
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
            return;
        }
    };

    let reloaded_cron_trigger_count = reloaded_daemon_config
        .triggers
        .into_parsed_cron_trigger_configs()
        .len();
    let reloaded_webhook_trigger_count = reloaded_daemon_config
        .triggers
        .into_parsed_webhook_trigger_configs()
        .len();
    let reloaded_watcher_trigger_count = reloaded_daemon_config
        .triggers
        .into_parsed_watcher_trigger_configs()
        .len();

    info!(
        cron_triggers = reloaded_cron_trigger_count,
        webhook_triggers = reloaded_webhook_trigger_count,
        watcher_triggers = reloaded_watcher_trigger_count,
        "parsed trigger counts from reloaded configuration \
         (trigger changes require daemon restart to take effect)"
    );

    let reloaded_notification_dispatcher = reloaded_daemon_config
        .notifications
        .build_dispatcher();
    let reloaded_notification_channel_count = reloaded_notification_dispatcher.channel_count();

    reloadable_notification_dispatcher
        .replace_dispatcher(reloaded_notification_dispatcher)
        .await;

    info!(
        notification_channel_count = reloaded_notification_channel_count,
        "notification dispatcher rebuilt from reloaded configuration"
    );

    info!("configuration reload complete");
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

    #[tokio::test]
    async fn reload_configuration_handles_missing_config_file_gracefully() {
        let missing_config_path = PathBuf::from("/tmp/kraken_nonexistent_reload_test.yml");
        let initial_dispatcher = NotificationDispatcher::new();
        let reloadable = Arc::new(ReloadableNotificationDispatcher::new(initial_dispatcher));

        reload_configuration_from_disk(
            Some(&missing_config_path),
            &reloadable,
        )
        .await;

        assert_eq!(reloadable.current_dispatcher().await.channel_count(), 0);
    }
}
