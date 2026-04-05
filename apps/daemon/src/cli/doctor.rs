use std::path::PathBuf;
use std::process::Command;

use console::style;
use serde::Serialize;

use super::output::{HumanDisplay, daemon_base_url};

const MINIMUM_BUN_VERSION: &str = "1.3.10";
const MINIMUM_DISK_SPACE_BYTES: u64 = 500_000_000;
const DATABASE_SIZE_DIVISOR: f64 = 1_048_576.0;

#[derive(Debug, Clone, Serialize)]
pub enum CheckStatus {
    Pass,
    Warning,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub name: String,
    pub status: CheckStatus,
    pub message: String,
    pub fix_hint: Option<String>,
    pub auto_fixable: bool,
}

#[derive(Serialize)]
pub struct DoctorReport {
    pub results: Vec<CheckResult>,
    pub passed: usize,
    pub warnings: usize,
    pub failed: usize,
}

impl HumanDisplay for DoctorReport {
    fn display_human(&self) {
        println!();
        println!("  {}", style("Kraken Doctor").bold());
        println!("  {}", style("─────────────").dim());
        println!();

        for result in &self.results {
            let icon_style = match result.status {
                CheckStatus::Pass => style("✓").green(),
                CheckStatus::Warning => style("⚠").yellow(),
                CheckStatus::Fail => style("✗").red(),
            };

            let padded_name = format!("{:<14}", result.name);
            println!(
                "  {} {} {}",
                icon_style,
                style(padded_name).dim(),
                result.message
            );

            if let Some(ref fix_hint) = result.fix_hint {
                println!(
                    "                   {}",
                    style(format!("Fix: {fix_hint}")).dim()
                );
            }
        }

        println!();
        println!(
            "  Result: {} passed, {} warnings, {} failed",
            style(self.passed).green(),
            style(self.warnings).yellow(),
            style(self.failed).red(),
        );
        println!();
    }
}

pub async fn execute(fix: bool, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut results = Vec::new();

    results.push(check_bun());
    results.push(check_git());
    results.push(check_ripgrep());
    results.push(check_kraken_directory(fix));
    results.push(check_config_file());
    results.push(check_env_file());
    results.push(check_api_keys());
    results.push(check_pid_file(fix));
    results.push(await_check_daemon().await);
    results.push(check_database());
    results.push(check_disk_space());
    results.push(check_app_bundle());
    results.push(check_worker_script());

    let passed = results
        .iter()
        .filter(|result| matches!(result.status, CheckStatus::Pass))
        .count();
    let warnings = results
        .iter()
        .filter(|result| matches!(result.status, CheckStatus::Warning))
        .count();
    let failed = results
        .iter()
        .filter(|result| matches!(result.status, CheckStatus::Fail))
        .count();

    let report = DoctorReport {
        results,
        passed,
        warnings,
        failed,
    };

    super::output::output(&report, json_mode);

    if report.failed > 0 {
        std::process::exit(1);
    }

    Ok(())
}

fn kraken_home_directory() -> PathBuf {
    dirs_next::home_dir().unwrap_or_default().join(".kraken")
}

fn check_bun() -> CheckResult {
    match Command::new("bun").arg("--version").output() {
        Ok(command_output) if command_output.status.success() => {
            let version = String::from_utf8_lossy(&command_output.stdout)
                .trim()
                .to_string();
            if version_at_least(&version, MINIMUM_BUN_VERSION) {
                CheckResult {
                    name: "bun".to_string(),
                    status: CheckStatus::Pass,
                    message: format!("Bun {version} installed"),
                    fix_hint: None,
                    auto_fixable: false,
                }
            } else {
                CheckResult {
                    name: "bun".to_string(),
                    status: CheckStatus::Warning,
                    message: format!(
                        "Bun {version} found, minimum recommended is {MINIMUM_BUN_VERSION}"
                    ),
                    fix_hint: Some("curl -fsSL https://bun.sh/install | bash".to_string()),
                    auto_fixable: false,
                }
            }
        }
        _ => CheckResult {
            name: "bun".to_string(),
            status: CheckStatus::Fail,
            message: "Bun is not installed".to_string(),
            fix_hint: Some("curl -fsSL https://bun.sh/install | bash".to_string()),
            auto_fixable: false,
        },
    }
}

fn check_git() -> CheckResult {
    match Command::new("git").arg("--version").output() {
        Ok(command_output) if command_output.status.success() => {
            let version_output = String::from_utf8_lossy(&command_output.stdout)
                .trim()
                .to_string();
            CheckResult {
                name: "git".to_string(),
                status: CheckStatus::Pass,
                message: version_output,
                fix_hint: None,
                auto_fixable: false,
            }
        }
        _ => CheckResult {
            name: "git".to_string(),
            status: CheckStatus::Fail,
            message: "Git is not installed".to_string(),
            fix_hint: Some("Install git from https://git-scm.com".to_string()),
            auto_fixable: false,
        },
    }
}

fn check_ripgrep() -> CheckResult {
    match Command::new("rg").arg("--version").output() {
        Ok(command_output) if command_output.status.success() => {
            let first_line = String::from_utf8_lossy(&command_output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            CheckResult {
                name: "ripgrep".to_string(),
                status: CheckStatus::Pass,
                message: first_line,
                fix_hint: None,
                auto_fixable: false,
            }
        }
        _ => CheckResult {
            name: "ripgrep".to_string(),
            status: CheckStatus::Warning,
            message: "ripgrep not found (grep tool will fall back to slower methods)".to_string(),
            fix_hint: Some("brew install ripgrep".to_string()),
            auto_fixable: false,
        },
    }
}

fn check_kraken_directory(fix: bool) -> CheckResult {
    let kraken_dir = kraken_home_directory();
    if kraken_dir.exists() {
        CheckResult {
            name: "kraken_dir".to_string(),
            status: CheckStatus::Pass,
            message: "~/.kraken/ exists".to_string(),
            fix_hint: None,
            auto_fixable: false,
        }
    } else if fix {
        match std::fs::create_dir_all(&kraken_dir) {
            Ok(_) => CheckResult {
                name: "kraken_dir".to_string(),
                status: CheckStatus::Pass,
                message: "~/.kraken/ created".to_string(),
                fix_hint: None,
                auto_fixable: true,
            },
            Err(creation_error) => CheckResult {
                name: "kraken_dir".to_string(),
                status: CheckStatus::Fail,
                message: format!("Failed to create ~/.kraken/: {creation_error}"),
                fix_hint: Some("mkdir -p ~/.kraken".to_string()),
                auto_fixable: false,
            },
        }
    } else {
        CheckResult {
            name: "kraken_dir".to_string(),
            status: CheckStatus::Warning,
            message: "~/.kraken/ directory does not exist".to_string(),
            fix_hint: Some("Run: kraken init".to_string()),
            auto_fixable: true,
        }
    }
}

fn check_config_file() -> CheckResult {
    let config_path = kraken_home_directory().join("kraken.jsonc");
    if config_path.exists() {
        match std::fs::read_to_string(&config_path) {
            Ok(config_contents) => {
                let stripped = strip_jsonc_comments(&config_contents);
                match serde_json::from_str::<serde_json::Value>(&stripped) {
                    Ok(_) => CheckResult {
                        name: "config".to_string(),
                        status: CheckStatus::Pass,
                        message: "kraken.jsonc valid".to_string(),
                        fix_hint: None,
                        auto_fixable: false,
                    },
                    Err(parse_error) => CheckResult {
                        name: "config".to_string(),
                        status: CheckStatus::Fail,
                        message: format!("kraken.jsonc has invalid JSON: {parse_error}"),
                        fix_hint: Some("Check syntax in ~/.kraken/kraken.jsonc".to_string()),
                        auto_fixable: false,
                    },
                }
            }
            Err(read_error) => CheckResult {
                name: "config".to_string(),
                status: CheckStatus::Fail,
                message: format!("Cannot read kraken.jsonc: {read_error}"),
                fix_hint: None,
                auto_fixable: false,
            },
        }
    } else {
        CheckResult {
            name: "config".to_string(),
            status: CheckStatus::Warning,
            message: "kraken.jsonc not found (defaults will be used)".to_string(),
            fix_hint: Some("Run: kraken init".to_string()),
            auto_fixable: false,
        }
    }
}

fn check_env_file() -> CheckResult {
    let env_path = kraken_home_directory().join(".env");
    if env_path.exists() {
        CheckResult {
            name: "env_file".to_string(),
            status: CheckStatus::Pass,
            message: "~/.kraken/.env exists".to_string(),
            fix_hint: None,
            auto_fixable: false,
        }
    } else {
        CheckResult {
            name: "env_file".to_string(),
            status: CheckStatus::Warning,
            message: "~/.kraken/.env not found (no secrets configured)".to_string(),
            fix_hint: Some("Run: kraken provider configure openrouter".to_string()),
            auto_fixable: false,
        }
    }
}

fn check_api_keys() -> CheckResult {
    let env_path = kraken_home_directory().join(".env");
    let env_contents = std::fs::read_to_string(&env_path).unwrap_or_default();

    let has_openrouter = env_contents.contains("OPENROUTER_API_KEY=")
        || std::env::var("OPENROUTER_API_KEY").is_ok()
        || std::env::var("KRAKEN_OPENROUTER_API_KEY").is_ok();
    let has_anthropic =
        env_contents.contains("ANTHROPIC_API_KEY=") || std::env::var("ANTHROPIC_API_KEY").is_ok();
    let has_openai =
        env_contents.contains("OPENAI_API_KEY=") || std::env::var("OPENAI_API_KEY").is_ok();

    if !has_openrouter && !has_anthropic && !has_openai {
        return CheckResult {
            name: "api_keys".to_string(),
            status: CheckStatus::Fail,
            message: "No LLM API key found".to_string(),
            fix_hint: Some("Run: kraken provider configure openrouter".to_string()),
            auto_fixable: false,
        };
    }

    let providers: Vec<&str> = [
        has_openrouter.then_some("OpenRouter"),
        has_anthropic.then_some("Anthropic"),
        has_openai.then_some("OpenAI"),
    ]
    .into_iter()
    .flatten()
    .collect();

    CheckResult {
        name: "api_keys".to_string(),
        status: CheckStatus::Pass,
        message: format!("Keys found: {}", providers.join(", ")),
        fix_hint: None,
        auto_fixable: false,
    }
}

fn check_pid_file(fix: bool) -> CheckResult {
    let pid_path = kraken_home_directory().join("daemon.pid");
    if !pid_path.exists() {
        return CheckResult {
            name: "pid_file".to_string(),
            status: CheckStatus::Pass,
            message: "No stale PID file".to_string(),
            fix_hint: None,
            auto_fixable: false,
        };
    }

    let pid_content = match std::fs::read_to_string(&pid_path) {
        Ok(content) => content,
        Err(_) => {
            return CheckResult {
                name: "pid_file".to_string(),
                status: CheckStatus::Warning,
                message: "Cannot read PID file".to_string(),
                fix_hint: Some("rm ~/.kraken/daemon.pid".to_string()),
                auto_fixable: true,
            };
        }
    };

    let parsed_pid: u32 = match pid_content.trim().parse() {
        Ok(parsed) => parsed,
        Err(_) => {
            if fix {
                let _ = std::fs::remove_file(&pid_path);
                return CheckResult {
                    name: "pid_file".to_string(),
                    status: CheckStatus::Pass,
                    message: "Removed invalid PID file".to_string(),
                    fix_hint: None,
                    auto_fixable: true,
                };
            }
            return CheckResult {
                name: "pid_file".to_string(),
                status: CheckStatus::Warning,
                message: "PID file contains invalid data".to_string(),
                fix_hint: Some("rm ~/.kraken/daemon.pid".to_string()),
                auto_fixable: true,
            };
        }
    };

    let process_running = sysinfo::System::new_all()
        .process(sysinfo::Pid::from_u32(parsed_pid))
        .is_some();

    if process_running {
        CheckResult {
            name: "pid_file".to_string(),
            status: CheckStatus::Pass,
            message: format!("PID file points to running process {parsed_pid}"),
            fix_hint: None,
            auto_fixable: false,
        }
    } else if fix {
        let _ = std::fs::remove_file(&pid_path);
        CheckResult {
            name: "pid_file".to_string(),
            status: CheckStatus::Pass,
            message: format!("Removed stale PID file (process {parsed_pid} not running)"),
            fix_hint: None,
            auto_fixable: true,
        }
    } else {
        CheckResult {
            name: "pid_file".to_string(),
            status: CheckStatus::Warning,
            message: format!("Stale PID file (process {parsed_pid} not running)"),
            fix_hint: Some("rm ~/.kraken/daemon.pid".to_string()),
            auto_fixable: true,
        }
    }
}

async fn await_check_daemon() -> CheckResult {
    let daemon_url = daemon_base_url();
    let health_url = format!("{daemon_url}/api/health");

    match reqwest::get(&health_url).await {
        Ok(response) if response.status().is_success() => {
            let status_url = format!("{daemon_url}/api/status");
            let uptime_display = match reqwest::get(&status_url).await {
                Ok(status_response) => {
                    if let Ok(status_json) = status_response.json::<serde_json::Value>().await {
                        let uptime_seconds = status_json
                            .get("uptime_seconds")
                            .and_then(|uptime_value| uptime_value.as_u64())
                            .unwrap_or(0);
                        let pid = status_json
                            .get("pid")
                            .and_then(|pid_value| pid_value.as_u64())
                            .unwrap_or(0);
                        format!("PID {pid}, uptime {}", format_uptime(uptime_seconds))
                    } else {
                        "running".to_string()
                    }
                }
                Err(_) => "running".to_string(),
            };

            CheckResult {
                name: "daemon".to_string(),
                status: CheckStatus::Pass,
                message: format!("Daemon running ({uptime_display})"),
                fix_hint: None,
                auto_fixable: false,
            }
        }
        _ => CheckResult {
            name: "daemon".to_string(),
            status: CheckStatus::Warning,
            message: "Daemon not running".to_string(),
            fix_hint: Some("kraken daemon start".to_string()),
            auto_fixable: false,
        },
    }
}

fn check_database() -> CheckResult {
    let database_path = kraken_home_directory().join("daemon.db");
    if !database_path.exists() {
        return CheckResult {
            name: "database".to_string(),
            status: CheckStatus::Pass,
            message: "No database yet (created on first run)".to_string(),
            fix_hint: None,
            auto_fixable: false,
        };
    }

    match rusqlite::Connection::open(&database_path) {
        Ok(connection) => {
            match connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            {
                Ok(integrity_result) if integrity_result == "ok" => {
                    let database_size_bytes = std::fs::metadata(&database_path)
                        .map(|metadata| metadata.len())
                        .unwrap_or(0);
                    let database_size_megabytes =
                        database_size_bytes as f64 / DATABASE_SIZE_DIVISOR;
                    CheckResult {
                        name: "database".to_string(),
                        status: CheckStatus::Pass,
                        message: format!("Database OK ({database_size_megabytes:.1} MB)"),
                        fix_hint: None,
                        auto_fixable: false,
                    }
                }
                Ok(integrity_result) => CheckResult {
                    name: "database".to_string(),
                    status: CheckStatus::Fail,
                    message: format!("Integrity check failed: {integrity_result}"),
                    fix_hint: Some(
                        "cp ~/.kraken/daemon.db ~/.kraken/daemon.db.bak && rm ~/.kraken/daemon.db"
                            .to_string(),
                    ),
                    auto_fixable: false,
                },
                Err(query_error) => CheckResult {
                    name: "database".to_string(),
                    status: CheckStatus::Fail,
                    message: format!("Integrity check query failed: {query_error}"),
                    fix_hint: None,
                    auto_fixable: false,
                },
            }
        }
        Err(open_error) => CheckResult {
            name: "database".to_string(),
            status: CheckStatus::Fail,
            message: format!("Cannot open database: {open_error}"),
            fix_hint: None,
            auto_fixable: false,
        },
    }
}

fn check_disk_space() -> CheckResult {
    let kraken_dir = kraken_home_directory();
    let target_path = if kraken_dir.exists() {
        kraken_dir
    } else {
        dirs_next::home_dir().unwrap_or_default()
    };

    let system_info = sysinfo::System::new_all();
    let disks = sysinfo::Disks::new_with_refreshed_list();

    let available_bytes = disks
        .iter()
        .filter(|disk| target_path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
        .unwrap_or(0);

    drop(system_info);

    let available_gigabytes = available_bytes as f64 / 1_073_741_824.0;

    if available_bytes < MINIMUM_DISK_SPACE_BYTES {
        CheckResult {
            name: "disk_space".to_string(),
            status: CheckStatus::Warning,
            message: format!("{available_gigabytes:.1} GB free (low)"),
            fix_hint: Some("Free up disk space".to_string()),
            auto_fixable: false,
        }
    } else {
        CheckResult {
            name: "disk_space".to_string(),
            status: CheckStatus::Pass,
            message: format!("{available_gigabytes:.1} GB free"),
            fix_hint: None,
            auto_fixable: false,
        }
    }
}

fn check_worker_script() -> CheckResult {
    let kraken_home = kraken_home_directory();

    // Production bundle (absolute path)
    let production_worker = kraken_home.join("lib").join("worker.js");
    if production_worker.exists() {
        return CheckResult {
            name: "worker".to_string(),
            status: CheckStatus::Pass,
            message: "Worker bundle found at ~/.kraken/lib/worker.js".to_string(),
            fix_hint: None,
            auto_fixable: false,
        };
    }

    // Development source (relative paths)
    let dev_candidates = ["apps/app/src/worker.ts", "../app/src/worker.ts"];
    for candidate_path in &dev_candidates {
        if std::path::Path::new(candidate_path).exists() {
            return CheckResult {
                name: "worker".to_string(),
                status: CheckStatus::Pass,
                message: format!("Worker source found at {candidate_path}"),
                fix_hint: None,
                auto_fixable: false,
            };
        }
    }

    CheckResult {
        name: "worker".to_string(),
        status: CheckStatus::Warning,
        message: "Worker script not found".to_string(),
        fix_hint: Some(
            "Reinstall kraken or run from the repo root for development".to_string(),
        ),
        auto_fixable: false,
    }
}

fn check_app_bundle() -> CheckResult {
    let kraken_home = kraken_home_directory();

    // Production bundle
    let production_app = kraken_home.join("lib").join("app").join("index.js");
    if production_app.exists() {
        return CheckResult {
            name: "app".to_string(),
            status: CheckStatus::Pass,
            message: "TUI app bundle found at ~/.kraken/lib/app/index.js".to_string(),
            fix_hint: None,
            auto_fixable: false,
        };
    }

    // Development source
    let dev_candidates = ["apps/app/src/index.tsx", "../app/src/index.tsx"];
    for candidate_path in &dev_candidates {
        if std::path::Path::new(candidate_path).exists() {
            return CheckResult {
                name: "app".to_string(),
                status: CheckStatus::Pass,
                message: format!("TUI source found at {candidate_path}"),
                fix_hint: None,
                auto_fixable: false,
            };
        }
    }

    CheckResult {
        name: "app".to_string(),
        status: CheckStatus::Fail,
        message: "TUI app not found".to_string(),
        fix_hint: Some(
            "Reinstall: curl -fsSL https://raw.githubusercontent.com/galfrevn/kraken/main/scripts/install.sh | bash".to_string(),
        ),
        auto_fixable: false,
    }
}

fn version_at_least(current: &str, minimum: &str) -> bool {
    let parse_version = |version_string: &str| -> Vec<u32> {
        version_string
            .split('.')
            .filter_map(|segment| segment.parse().ok())
            .collect()
    };

    let current_parts = parse_version(current);
    let minimum_parts = parse_version(minimum);

    for (index, &minimum_segment) in minimum_parts.iter().enumerate() {
        let current_segment = current_parts.get(index).copied().unwrap_or(0);
        if current_segment > minimum_segment {
            return true;
        }
        if current_segment < minimum_segment {
            return false;
        }
    }
    true
}

fn format_uptime(total_seconds: u64) -> String {
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

fn strip_jsonc_comments(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    let bytes = input.as_bytes();
    let length = bytes.len();

    while cursor < length {
        if bytes[cursor] == b'"' {
            output.push('"');
            cursor += 1;
            while cursor < length && bytes[cursor] != b'"' {
                if bytes[cursor] == b'\\' && cursor + 1 < length {
                    output.push(bytes[cursor] as char);
                    output.push(bytes[cursor + 1] as char);
                    cursor += 2;
                } else {
                    output.push(bytes[cursor] as char);
                    cursor += 1;
                }
            }
            if cursor < length {
                output.push('"');
                cursor += 1;
            }
        } else if cursor + 1 < length && bytes[cursor] == b'/' && bytes[cursor + 1] == b'/' {
            cursor += 2;
            while cursor < length && bytes[cursor] != b'\n' {
                cursor += 1;
            }
        } else if cursor + 1 < length && bytes[cursor] == b'/' && bytes[cursor + 1] == b'*' {
            cursor += 2;
            while cursor + 1 < length && !(bytes[cursor] == b'*' && bytes[cursor + 1] == b'/') {
                cursor += 1;
            }
            if cursor + 1 < length {
                cursor += 2;
            }
        } else {
            output.push(bytes[cursor] as char);
            cursor += 1;
        }
    }
    output
}
