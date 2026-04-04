use serde::Serialize;
use tabled::{Table, Tabled};

use crate::cli::output::{HumanDisplay, daemon_base_url, output, output_error};
use crate::daemon::config::DaemonConfig;

// ─── Table row ───────────────────────────────────────────────────────────────

#[derive(Tabled)]
struct NotificationChannelTableRow {
    #[tabled(rename = "NAME")]
    channel_name: String,
    #[tabled(rename = "PROVIDER")]
    provider_name: String,
    #[tabled(rename = "EVENTS")]
    subscribed_events: String,
}

// ─── List output ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct NotificationChannelEntry {
    pub name: String,
    pub provider: String,
    pub events: Vec<String>,
}

#[derive(Serialize)]
pub struct NotificationListOutput {
    pub channels: Vec<NotificationChannelEntry>,
}

impl HumanDisplay for NotificationListOutput {
    fn display_human(&self) {
        if self.channels.is_empty() {
            println!("No notification channels configured. Add channels to kraken.jsonc.");
            return;
        }

        let table_rows: Vec<NotificationChannelTableRow> = self
            .channels
            .iter()
            .map(|channel_entry| NotificationChannelTableRow {
                channel_name: channel_entry.name.clone(),
                provider_name: channel_entry.provider.clone(),
                subscribed_events: channel_entry.events.join(", "),
            })
            .collect();

        let rendered_table = Table::new(table_rows).to_string();
        println!("{rendered_table}");
        println!("{} channel(s) configured", self.channels.len());
    }
}

// ─── Test output ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct NotificationTestOutput {
    pub channel_name: String,
    pub status: String,
    pub message: String,
}

impl HumanDisplay for NotificationTestOutput {
    fn display_human(&self) {
        println!(
            "Notification channel '{}': {}",
            self.channel_name, self.message
        );
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn handle_connection_error(http_error: &reqwest::Error, json_mode: bool) {
    if http_error.is_connect() || http_error.is_timeout() {
        output_error(
            "daemon not running",
            Some("Start it with: kraken start"),
            json_mode,
        );
    } else {
        output_error(&format!("request failed: {http_error}"), None, json_mode);
    }
}

// ─── Subcommand handlers ─────────────────────────────────────────────────────

async fn handle_list(json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let daemon_config = match DaemonConfig::load(None) {
        Ok(loaded_config) => loaded_config,
        Err(config_load_error) => {
            output_error(
                &format!("failed to load kraken.jsonc: {config_load_error}"),
                Some("Run 'kraken init' to create a config file"),
                json_mode,
            );
            return Ok(());
        }
    };

    let channel_entries: Vec<NotificationChannelEntry> = daemon_config
        .notifications
        .channels
        .iter()
        .map(|notification_channel| NotificationChannelEntry {
            name: notification_channel.name.clone(),
            provider: notification_channel.provider.clone(),
            events: notification_channel.events.clone(),
        })
        .collect();

    let notification_list_output = NotificationListOutput {
        channels: channel_entries,
    };
    output(&notification_list_output, json_mode);
    Ok(())
}

async fn handle_test(
    channel_name: String,
    test_message: String,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let test_endpoint_url = format!(
        "{}/api/notifications/{}/test",
        daemon_base_url(),
        channel_name
    );

    let request_body = serde_json::json!({
        "message": test_message,
    });

    let http_response = match http_client
        .post(&test_endpoint_url)
        .json(&request_body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(connection_error) => {
            handle_connection_error(&connection_error, json_mode);
            return Ok(());
        }
    };

    let response_status_code = http_response.status();

    if response_status_code == reqwest::StatusCode::NOT_FOUND {
        output_error(
            &format!(
                "channel '{}' not found or endpoint not yet implemented in daemon",
                channel_name
            ),
            Some("Check your kraken.jsonc for the channel name"),
            json_mode,
        );
        return Ok(());
    }

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "notification test failed (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    let test_output = NotificationTestOutput {
        channel_name: channel_name.clone(),
        status: "sent".to_string(),
        message: format!("Test notification sent to channel '{}'", channel_name),
    };
    output(&test_output, json_mode);
    Ok(())
}

// ─── Entry point ─────────────────────────────────────────────────────────────

pub async fn execute(
    command: crate::cli::NotificationCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        crate::cli::NotificationCommands::List => handle_list(json_mode).await,
        crate::cli::NotificationCommands::Test {
            channel_name,
            message,
        } => handle_test(channel_name, message, json_mode).await,
    }
}
