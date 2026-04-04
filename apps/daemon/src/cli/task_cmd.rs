use serde::{Deserialize, Serialize};
use tabled::{Table, Tabled};

use crate::cli::output::{HumanDisplay, daemon_base_url, output, output_error};

// ─── Response structs ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TaskCreateResponse {
    pub id: String,
    pub prompt: String,
    pub status: String,
    pub priority: i32,
    pub agent: String,
}

impl HumanDisplay for TaskCreateResponse {
    fn display_human(&self) {
        let short_task_id = &self.id[..self.id.len().min(8)];
        println!("Task created: {short_task_id}");
        println!("  Prompt:   {}", self.prompt);
        println!("  Priority: {}", self.priority);
        println!("  Status:   {}", self.status);
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TaskSummary {
    pub id: String,
    pub name: Option<String>,
    pub status: String,
    pub priority: i32,
    pub created_at: String,
    pub agent: String,
    pub prompt: Option<String>,
}

#[derive(Tabled)]
struct TaskTableRow {
    #[tabled(rename = "ID")]
    short_id: String,
    #[tabled(rename = "STATUS")]
    status: String,
    #[tabled(rename = "PRIORITY")]
    priority: String,
    #[tabled(rename = "CREATED")]
    created_at: String,
    #[tabled(rename = "PROMPT")]
    truncated_prompt: String,
}

#[derive(Serialize, Deserialize)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskSummary>,
    pub total_count: i32,
}

impl HumanDisplay for TaskListResponse {
    fn display_human(&self) {
        let table_rows: Vec<TaskTableRow> = self
            .tasks
            .iter()
            .map(|task_summary| {
                let short_id = task_summary.id[..task_summary.id.len().min(8)].to_string();
                let raw_prompt = task_summary
                    .prompt
                    .as_deref()
                    .or(task_summary.name.as_deref())
                    .unwrap_or("—");
                let truncated_prompt = if raw_prompt.len() > 40 {
                    format!("{}…", &raw_prompt[..39])
                } else {
                    raw_prompt.to_string()
                };
                TaskTableRow {
                    short_id,
                    status: task_summary.status.clone(),
                    priority: task_summary.priority.to_string(),
                    created_at: task_summary.created_at.clone(),
                    truncated_prompt,
                }
            })
            .collect();

        let rendered_table = Table::new(table_rows).to_string();
        println!("{rendered_table}");
        println!("Showing {} of {} tasks", self.tasks.len(), self.total_count);
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TaskDetailResponse {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub priority: i32,
    pub agent: Option<String>,
    pub trigger_id: Option<String>,
    pub trigger_type: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub worker_pid: Option<i32>,
    pub worker_dir: Option<String>,
    pub exit_code: Option<i32>,
    pub output: Option<String>,
    pub error_message: Option<String>,
    pub attempt: Option<i32>,
    pub max_retries: Option<i32>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub estimated_cost_usd: Option<f64>,
}

impl HumanDisplay for TaskDetailResponse {
    fn display_human(&self) {
        let short_task_id = &self.id[..self.id.len().min(8)];
        println!("Task:       {short_task_id} ({})", self.id);
        println!("Status:     {}", self.status);
        println!("Priority:   {}", self.priority);
        if let Some(ref agent_name) = self.agent {
            println!("Agent:      {agent_name}");
        }
        if let Some(ref trigger_type) = self.trigger_type {
            println!("Trigger:    {trigger_type}");
        }
        println!("Created:    {}", self.created_at);
        if let Some(ref started_timestamp) = self.started_at {
            println!("Started:    {started_timestamp}");
        }
        if let Some(ref completed_timestamp) = self.completed_at {
            println!("Completed:  {completed_timestamp}");
        }
        if let Some(running_worker_pid) = self.worker_pid {
            println!("Worker PID: {running_worker_pid}");
        }
        if let Some(ref worker_directory) = self.worker_dir {
            println!("Worktree:   {worker_directory}");
        }
        if let Some(current_attempt_number) = self.attempt {
            println!("Attempt:    {current_attempt_number}");
        }
        if let Some(code) = self.exit_code {
            println!("Exit code:  {code}");
        }
        if let Some(ref task_name) = self.name {
            println!("Name:       {task_name}");
        }
        if let Some(ref desc) = self.description {
            println!("Prompt:     {desc}");
        }
        let total_tokens = self.prompt_tokens.unwrap_or(0) + self.completion_tokens.unwrap_or(0);
        if total_tokens > 0 {
            println!("Tokens:     {total_tokens}");
        }
        if let Some(cost) = self.estimated_cost_usd {
            println!("Cost:       ${cost:.4}");
        }
        if let Some(ref error) = self.error_message {
            println!("Error:      {error}");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TaskCancelResponse {
    pub id: String,
    pub status: String,
}

impl HumanDisplay for TaskCancelResponse {
    fn display_human(&self) {
        let short_task_id = &self.id[..self.id.len().min(8)];
        println!("Task {short_task_id} cancelled");
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TaskDeleteResponse {
    pub task_id: String,
    pub status: String,
}

impl HumanDisplay for TaskDeleteResponse {
    fn display_human(&self) {
        let short_task_id = &self.task_id[..self.task_id.len().min(8)];
        println!("Task {short_task_id} deleted");
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TaskRetryResponse {
    pub id: String,
    pub status: String,
    pub attempt: i32,
}

impl HumanDisplay for TaskRetryResponse {
    fn display_human(&self) {
        let short_task_id = &self.id[..self.id.len().min(8)];
        println!(
            "Task {short_task_id} re-enqueued (attempt {})",
            self.attempt
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

#[derive(Serialize, Deserialize)]
pub struct TaskLogsResponse {
    pub logs: Vec<LogEntry>,
}

impl HumanDisplay for TaskLogsResponse {
    fn display_human(&self) {
        for log_entry in &self.logs {
            println!(
                "{} [{}] {}",
                log_entry.timestamp, log_entry.level, log_entry.message
            );
        }
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

async fn handle_create(
    task_prompt: String,
    task_priority: i32,
    agent_id: String,
    workdir: Option<String>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let schedule_endpoint_url = format!("{}/api/schedule", daemon_base_url());

    let resolved_workdir = workdir.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });

    let request_body = serde_json::json!({
        "prompt": task_prompt,
        "priority": task_priority,
        "agent": agent_id,
        "workdir": resolved_workdir,
    });

    let http_response = match http_client
        .post(&schedule_endpoint_url)
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

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "failed to create task (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    match http_response.json::<TaskCreateResponse>().await {
        Ok(create_response) => output(&create_response, json_mode),
        Err(deserialization_error) => {
            output_error(
                &format!("failed to parse response: {deserialization_error}"),
                None,
                json_mode,
            );
        }
    }

    Ok(())
}

async fn handle_list(
    status_filter: String,
    max_results_limit: i32,
    pagination_offset: i32,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let list_endpoint_url = format!(
        "{}/api/tasks?status={}&limit={}&offset={}",
        daemon_base_url(),
        status_filter,
        max_results_limit,
        pagination_offset
    );

    let http_response = match http_client.get(&list_endpoint_url).send().await {
        Ok(response) => response,
        Err(connection_error) => {
            handle_connection_error(&connection_error, json_mode);
            return Ok(());
        }
    };

    let response_status_code = http_response.status();

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "failed to list tasks (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    match http_response.json::<TaskListResponse>().await {
        Ok(list_response) => output(&list_response, json_mode),
        Err(deserialization_error) => {
            output_error(
                &format!("failed to parse response: {deserialization_error}"),
                None,
                json_mode,
            );
        }
    }

    Ok(())
}

async fn handle_show(task_id: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let show_endpoint_url = format!("{}/api/tasks/{}", daemon_base_url(), task_id);

    let http_response = match http_client.get(&show_endpoint_url).send().await {
        Ok(response) => response,
        Err(connection_error) => {
            handle_connection_error(&connection_error, json_mode);
            return Ok(());
        }
    };

    let response_status_code = http_response.status();

    if response_status_code == reqwest::StatusCode::NOT_FOUND {
        output_error("task not found", None, json_mode);
        return Ok(());
    }

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "failed to get task (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    match http_response.json::<TaskDetailResponse>().await {
        Ok(detail_response) => output(&detail_response, json_mode),
        Err(deserialization_error) => {
            output_error(
                &format!("failed to parse response: {deserialization_error}"),
                None,
                json_mode,
            );
        }
    }

    Ok(())
}

async fn handle_cancel(task_id: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let cancel_endpoint_url = format!("{}/api/tasks/{}/cancel", daemon_base_url(), task_id);

    let http_response = match http_client.post(&cancel_endpoint_url).send().await {
        Ok(response) => response,
        Err(connection_error) => {
            handle_connection_error(&connection_error, json_mode);
            return Ok(());
        }
    };

    let response_status_code = http_response.status();

    if response_status_code == reqwest::StatusCode::NOT_FOUND {
        output_error("task not found", None, json_mode);
        return Ok(());
    }

    if response_status_code == reqwest::StatusCode::CONFLICT {
        output_error(
            "operation not allowed on task in current state",
            None,
            json_mode,
        );
        return Ok(());
    }

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "failed to cancel task (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    match http_response.json::<TaskCancelResponse>().await {
        Ok(cancel_response) => output(&cancel_response, json_mode),
        Err(deserialization_error) => {
            output_error(
                &format!("failed to parse response: {deserialization_error}"),
                None,
                json_mode,
            );
        }
    }

    Ok(())
}

async fn handle_delete(task_id: String, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let delete_endpoint_url = format!("{}/api/tasks/{}", daemon_base_url(), task_id);

    let http_response = match http_client.delete(&delete_endpoint_url).send().await {
        Ok(response) => response,
        Err(connection_error) => {
            handle_connection_error(&connection_error, json_mode);
            return Ok(());
        }
    };

    let response_status_code = http_response.status();

    if response_status_code == reqwest::StatusCode::NOT_FOUND {
        output_error("task not found", None, json_mode);
        return Ok(());
    }

    if response_status_code == reqwest::StatusCode::CONFLICT {
        output_error("only pending tasks can be deleted", None, json_mode);
        return Ok(());
    }

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "failed to delete task (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    match http_response.json::<TaskDeleteResponse>().await {
        Ok(delete_response) => output(&delete_response, json_mode),
        Err(deserialization_error) => {
            output_error(
                &format!("failed to parse response: {deserialization_error}"),
                None,
                json_mode,
            );
        }
    }

    Ok(())
}

async fn handle_retry(
    task_id: String,
    override_agent: Option<String>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let http_client = reqwest::Client::new();
    let retry_endpoint_url = format!("{}/api/tasks/{}/retry", daemon_base_url(), task_id);

    let request_body = serde_json::json!({
        "agent": override_agent,
    });

    let http_response = match http_client
        .post(&retry_endpoint_url)
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
        output_error("task not found", None, json_mode);
        return Ok(());
    }

    if response_status_code == reqwest::StatusCode::CONFLICT {
        output_error(
            "operation not allowed on task in current state",
            None,
            json_mode,
        );
        return Ok(());
    }

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "failed to retry task (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    match http_response.json::<TaskRetryResponse>().await {
        Ok(retry_response) => output(&retry_response, json_mode),
        Err(deserialization_error) => {
            output_error(
                &format!("failed to parse response: {deserialization_error}"),
                None,
                json_mode,
            );
        }
    }

    Ok(())
}

async fn handle_logs(
    task_id: String,
    follow_stream: bool,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if follow_stream {
        eprintln!("warning: streaming not yet supported, showing latest logs");
    }

    let http_client = reqwest::Client::new();
    let logs_endpoint_url = format!("{}/api/tasks/{}/logs", daemon_base_url(), task_id);

    let http_response = match http_client.get(&logs_endpoint_url).send().await {
        Ok(response) => response,
        Err(connection_error) => {
            handle_connection_error(&connection_error, json_mode);
            return Ok(());
        }
    };

    let response_status_code = http_response.status();

    if response_status_code == reqwest::StatusCode::NOT_FOUND {
        output_error("task not found", None, json_mode);
        return Ok(());
    }

    if !response_status_code.is_success() {
        output_error(
            &format!(
                "failed to get task logs (HTTP {})",
                response_status_code.as_u16()
            ),
            None,
            json_mode,
        );
        return Ok(());
    }

    match http_response.json::<TaskLogsResponse>().await {
        Ok(logs_response) => output(&logs_response, json_mode),
        Err(deserialization_error) => {
            output_error(
                &format!("failed to parse response: {deserialization_error}"),
                None,
                json_mode,
            );
        }
    }

    Ok(())
}

// ─── Entry point ─────────────────────────────────────────────────────────────

pub async fn execute(
    command: crate::cli::TaskCommands,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        crate::cli::TaskCommands::Create {
            prompt,
            priority,
            agent,
            workdir,
        } => handle_create(prompt, priority, agent, workdir, json_mode).await,
        crate::cli::TaskCommands::List {
            status,
            limit,
            offset,
        } => handle_list(status, limit, offset, json_mode).await,
        crate::cli::TaskCommands::Show { task_id } => handle_show(task_id, json_mode).await,
        crate::cli::TaskCommands::Cancel { task_id } => handle_cancel(task_id, json_mode).await,
        crate::cli::TaskCommands::Delete { task_id } => handle_delete(task_id, json_mode).await,
        crate::cli::TaskCommands::Retry { task_id, agent } => {
            handle_retry(task_id, agent, json_mode).await
        }
        crate::cli::TaskCommands::Logs { task_id, follow } => {
            handle_logs(task_id, follow, json_mode).await
        }
    }
}
