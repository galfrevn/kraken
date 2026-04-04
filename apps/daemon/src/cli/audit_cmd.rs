use console::style;
use std::path::PathBuf;

use crate::db::audit::{AuditQueryParams, AuditStore, open_audit_database};

fn resolve_audit_db_path() -> PathBuf {
    dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".kraken")
        .join("audit.db")
}

pub async fn execute(
    session_id: Option<String>,
    file_path: Option<String>,
    event_type: Option<String>,
    since: Option<String>,
    summary: bool,
    limit: Option<i32>,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let audit_db_path = resolve_audit_db_path();

    if !audit_db_path.exists() {
        if json_mode {
            println!(
                "{}",
                serde_json::json!({ "error": "audit database not found" })
            );
        } else {
            eprintln!(
                "{} Audit database not found at {}",
                style("✗").red().bold(),
                audit_db_path.display()
            );
            eprintln!("  The daemon must be running at least once to create the audit database.");
        }
        return Ok(());
    }

    let pool = open_audit_database(&audit_db_path)?;
    let store = AuditStore::new(pool);

    if summary {
        let audit_summary = store.summary().await;
        if json_mode {
            println!("{}", serde_json::to_string_pretty(&audit_summary)?);
        } else {
            println!("{}", style("Audit Summary").bold().underlined());
            println!("  Total events:       {}", audit_summary.total_events);
            println!("  Tool calls:         {}", audit_summary.tool_calls);
            println!("  LLM calls:          {}", audit_summary.llm_calls);
            println!("  File operations:    {}", audit_summary.file_operations);
            println!("  Command executions: {}", audit_summary.command_executions);
            println!(
                "  Errors:             {}",
                style(audit_summary.errors).red()
            );
        }
        return Ok(());
    }

    let params = AuditQueryParams {
        session_id,
        event_type,
        target: file_path,
        since,
        limit: Some(limit.unwrap_or(20)),
        offset: None,
    };

    let events = store.query_events(&params).await;

    if json_mode {
        println!("{}", serde_json::to_string_pretty(&events)?);
        return Ok(());
    }

    if events.is_empty() {
        println!(
            "{}",
            style("No audit events found matching the query.").dim()
        );
        return Ok(());
    }

    for event in &events {
        let timestamp = event.timestamp.as_deref().unwrap_or("?");
        let success_indicator = if event.success {
            style("✓").green()
        } else {
            style("✗").red()
        };

        let tool_display = event.tool.as_deref().unwrap_or("-");
        let target_display = event.target.as_deref().unwrap_or("");

        println!(
            "  {} {} {} {} {}",
            style(timestamp).dim(),
            success_indicator,
            style(&event.event_type).cyan(),
            style(tool_display).yellow(),
            target_display,
        );

        if let Some(ref error_msg) = event.error_message {
            println!("    {} {}", style("error:").red(), error_msg);
        }

        if let Some(duration) = event.duration_ms {
            println!("    {} {}ms", style("duration:").dim(), duration);
        }
    }

    println!("\n  {} {} events shown", style("→").dim(), events.len());

    Ok(())
}
