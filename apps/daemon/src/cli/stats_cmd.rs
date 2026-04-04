use chrono::Local;
use serde::{Deserialize, Serialize};

use crate::cli::output::{HumanDisplay, daemon_base_url, output, output_error};

#[derive(Serialize, Deserialize)]
pub struct StatsResponse {
    pub completed: i64,
    pub failed: i64,
    pub pending: i64,
    pub running: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost_usd: f64,
}

impl HumanDisplay for StatsResponse {
    fn display_human(&self) {
        println!();
        println!(
            "Tasks:   {} completed, {} failed, {} pending",
            self.completed, self.failed, self.pending
        );
        println!(
            "Tokens:  {} prompt / {} completion",
            format_token_count(self.prompt_tokens),
            format_token_count(self.completion_tokens),
        );
        println!("Cost:    ${:.2}", self.cost_usd);
    }
}

fn format_token_count(token_count: i64) -> String {
    if token_count >= 1_000_000 {
        format!("{:.1}M", token_count as f64 / 1_000_000.0)
    } else if token_count >= 1_000 {
        let thousands = token_count / 1_000;
        let remainder = (token_count % 1_000) / 100;
        if remainder == 0 {
            format!("{}K", thousands)
        } else {
            format!("{}.{}K", thousands, remainder)
        }
    } else {
        token_count.to_string()
    }
}

pub async fn execute(period: &str, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let today_date = Local::now().format("%Y-%m-%d").to_string();

    if !json_mode {
        println!("Period: {} ({})", period, today_date);
    }

    let request_url = format!("{}/api/stats?period={}", daemon_base_url(), period);

    let http_response = match reqwest::get(&request_url).await {
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
            "stats endpoint not available, daemon may need update",
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

    let stats_response: StatsResponse = match http_response.json().await {
        Ok(parsed_response) => parsed_response,
        Err(parse_error) => {
            output_error(
                &format!("failed to parse stats response: {parse_error}"),
                None,
                json_mode,
            );
            return Ok(());
        }
    };

    output(&stats_response, json_mode);
    Ok(())
}
