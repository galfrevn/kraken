use serde::{Deserialize, Serialize};

use crate::cli::output::{HumanDisplay, daemon_base_url, output, output_error};

#[derive(Serialize)]
struct CleanRequestBody {
    worktrees: bool,
    task_days: Option<u32>,
    dry_run: bool,
}

#[derive(Serialize, Deserialize)]
pub struct CleanResponse {
    pub worktrees_removed: i64,
    pub tasks_removed: i64,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub task_days: Option<u32>,
}

impl HumanDisplay for CleanResponse {
    fn display_human(&self) {
        let action_prefix = if self.dry_run {
            "Would clean"
        } else {
            "Cleaned"
        };

        if self.worktrees_removed > 0 || self.dry_run {
            println!("{action_prefix} {} stale worktrees", self.worktrees_removed);
        }

        if self.tasks_removed > 0 || self.dry_run {
            let days_label = self.task_days.unwrap_or(30);
            println!(
                "{action_prefix} {} tasks older than {} days",
                self.tasks_removed, days_label
            );
        }

        if self.worktrees_removed == 0 && self.tasks_removed == 0 && !self.dry_run {
            println!("Nothing to clean.");
        }
    }
}

pub async fn execute(
    worktrees: bool,
    tasks: Option<u32>,
    dry_run: bool,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    // Determine what to clean based on flags.
    // If neither --worktrees nor --tasks is given, default to cleaning both.
    let should_clean_worktrees;
    let task_days_to_clean;

    let neither_flag_given = !worktrees && tasks.is_none();

    if neither_flag_given {
        should_clean_worktrees = true;
        task_days_to_clean = Some(30u32);
    } else {
        should_clean_worktrees = worktrees;
        task_days_to_clean = tasks;
    }

    let request_body = CleanRequestBody {
        worktrees: should_clean_worktrees,
        task_days: task_days_to_clean,
        dry_run,
    };

    let request_url = format!("{}/api/clean", daemon_base_url());

    let http_client = reqwest::Client::new();
    let http_response = match http_client
        .post(&request_url)
        .json(&request_body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(connection_error) => {
            output_error(
                &format!("daemon not reachable: {connection_error}"),
                Some("start the daemon with: kraken daemon"),
                json_mode,
            );
            return Ok(());
        }
    };

    if http_response.status() == reqwest::StatusCode::NOT_FOUND {
        output_error(
            "clean endpoint not available, daemon may need update",
            None,
            json_mode,
        );
        return Ok(());
    }

    if !http_response.status().is_success() {
        let status_code = http_response.status();
        let error_body = http_response.text().await.unwrap_or_default();
        output_error(
            &format!("daemon returned error {status_code}: {error_body}"),
            None,
            json_mode,
        );
        return Ok(());
    }

    let mut clean_response: CleanResponse = match http_response.json().await {
        Ok(parsed_response) => parsed_response,
        Err(parse_error) => {
            output_error(
                &format!("failed to parse clean response: {parse_error}"),
                None,
                json_mode,
            );
            return Ok(());
        }
    };

    // Propagate the dry_run and task_days values for display purposes
    clean_response.dry_run = dry_run;
    clean_response.task_days = task_days_to_clean;

    output(&clean_response, json_mode);
    Ok(())
}
