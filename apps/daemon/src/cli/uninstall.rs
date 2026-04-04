use crate::cli::output::{HumanDisplay, output};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct UninstallResult {
    pub removed: Vec<String>,
    pub skipped: Vec<String>,
}

impl HumanDisplay for UninstallResult {
    fn display_human(&self) {
        for path in &self.removed {
            println!("  removed: {path}");
        }
        for path in &self.skipped {
            println!("  skipped (not found): {path}");
        }
        if self.removed.is_empty() {
            println!("Nothing to remove.");
        } else {
            println!("\nKraken uninstalled successfully.");
        }
    }
}

pub async fn execute(
    keep_global: bool,
    yes: bool,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(pid) = crate::daemon::is_daemon_running() {
        if !json_mode {
            println!("Stopping running daemon (PID {pid})...");
        }
        crate::cli::stop::execute(false, json_mode).await?;
    }

    let mut paths_to_remove: Vec<PathBuf> = Vec::new();

    if !keep_global && let Some(home_directory) = dirs_next::home_dir() {
        let kraken_global_directory = home_directory.join(".kraken");
        if kraken_global_directory.exists() {
            paths_to_remove.push(kraken_global_directory);
        }
    }

    if paths_to_remove.is_empty() {
        let result = UninstallResult {
            removed: vec![],
            skipped: vec![],
        };
        output(&result, json_mode);
        return Ok(());
    }

    if !yes && !json_mode {
        println!("The following will be removed:");
        for path in &paths_to_remove {
            println!("  {}", path.display());
        }
        print!("\nContinue? [y/N] ");
        use std::io::Write;
        std::io::stdout().flush()?;
        let mut confirmation_input = String::new();
        std::io::stdin().read_line(&mut confirmation_input)?;
        if !confirmation_input.trim().eq_ignore_ascii_case("y") {
            println!("Aborted.");
            return Ok(());
        }
    }

    let mut removed: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for path in paths_to_remove {
        let display_path = path.display().to_string();
        if path.exists() {
            let removal_result = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            match removal_result {
                Ok(()) => removed.push(display_path),
                Err(error) => {
                    if !json_mode {
                        eprintln!("  warning: failed to remove {}: {}", display_path, error);
                    }
                    skipped.push(display_path);
                }
            }
        } else {
            skipped.push(display_path);
        }
    }

    let result = UninstallResult { removed, skipped };
    output(&result, json_mode);
    Ok(())
}
