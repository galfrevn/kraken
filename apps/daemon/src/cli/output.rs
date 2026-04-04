use serde::Serialize;
use std::io::IsTerminal;

pub trait HumanDisplay {
    fn display_human(&self);
}

#[derive(Serialize)]
pub struct CliError {
    pub error: String,
    pub hint: Option<String>,
}

impl HumanDisplay for CliError {
    fn display_human(&self) {
        eprintln!("error: {}", self.error);
        if let Some(ref hint) = self.hint {
            eprintln!("hint:  {hint}");
        }
    }
}

pub fn output<T: Serialize + HumanDisplay>(data: &T, json_mode: bool) {
    if json_mode || !std::io::stdout().is_terminal() {
        println!("{}", serde_json::to_string_pretty(data).unwrap());
    } else {
        data.display_human();
    }
}

pub fn output_error(error: &str, hint: Option<&str>, json_mode: bool) {
    let cli_error = CliError {
        error: error.to_string(),
        hint: hint.map(|hint_text| hint_text.to_string()),
    };
    if json_mode || !std::io::stderr().is_terminal() {
        eprintln!("{}", serde_json::to_string_pretty(&cli_error).unwrap());
    } else {
        cli_error.display_human();
    }
}

pub fn daemon_base_url() -> String {
    let port = std::env::var("DAEMON_PORT")
        .ok()
        .and_then(|port_string| port_string.parse::<u16>().ok())
        .unwrap_or(50051);
    format!("http://127.0.0.1:{port}")
}

pub async fn is_daemon_reachable() -> bool {
    let url = format!("{}/api/health", daemon_base_url());
    reqwest::get(&url)
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}
