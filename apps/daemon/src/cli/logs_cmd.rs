use std::io::{Read, Seek, SeekFrom};

pub async fn execute(
    follow: bool,
    lines: u32,
    _json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let daemon_log_file_path = resolve_log_file_path();

    if !daemon_log_file_path.exists() {
        eprintln!(
            "no daemon log file found at {}",
            daemon_log_file_path.display()
        );
        return Ok(());
    }

    let raw_file_contents = std::fs::read_to_string(&daemon_log_file_path)?;
    let all_log_lines: Vec<&str> = raw_file_contents.lines().collect();

    let lines_to_display = lines as usize;
    let starting_line_index = if all_log_lines.len() > lines_to_display {
        all_log_lines.len() - lines_to_display
    } else {
        0
    };

    for log_line in &all_log_lines[starting_line_index..] {
        println!("{log_line}");
    }

    if !follow {
        return Ok(());
    }

    // Poll the file for new content until interrupted
    let mut log_file = std::fs::File::open(&daemon_log_file_path)?;
    let mut current_byte_position = log_file.seek(SeekFrom::End(0))?;

    let polling_interval = std::time::Duration::from_millis(200);

    loop {
        std::thread::sleep(polling_interval);

        let updated_file_size = log_file.seek(SeekFrom::End(0))?;

        if updated_file_size > current_byte_position {
            log_file.seek(SeekFrom::Start(current_byte_position))?;

            let new_byte_count = (updated_file_size - current_byte_position) as usize;
            let mut new_bytes_buffer = vec![0u8; new_byte_count];
            log_file.read_exact(&mut new_bytes_buffer)?;

            let new_content = String::from_utf8_lossy(&new_bytes_buffer);
            for new_line in new_content.lines() {
                println!("{new_line}");
            }

            current_byte_position = updated_file_size;
        }
    }
}

fn resolve_log_file_path() -> std::path::PathBuf {
    if let Ok(env_override_path) = std::env::var("KRAKEN_DAEMON_LOG_FILE") {
        return std::path::PathBuf::from(env_override_path);
    }

    dirs_next::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".kraken")
        .join("daemon.log")
}
