use std::collections::HashMap;
use std::path::PathBuf;

pub fn resolve_kraken_home_directory() -> PathBuf {
    dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".kraken")
}

pub fn resolve_env_file_path() -> PathBuf {
    resolve_kraken_home_directory().join(".env")
}

pub fn read_env_map(env_file_path: &PathBuf) -> HashMap<String, String> {
    if !env_file_path.exists() {
        return HashMap::new();
    }

    let raw_file_contents = std::fs::read_to_string(env_file_path).unwrap_or_default();
    let mut key_value_map: HashMap<String, String> = HashMap::new();

    for line in raw_file_contents.lines() {
        let trimmed_line = line.trim();
        if trimmed_line.is_empty() || trimmed_line.starts_with('#') {
            continue;
        }
        if let Some(equals_position) = trimmed_line.find('=') {
            let key = trimmed_line[..equals_position].trim().to_string();
            let value = trimmed_line[equals_position + 1..].trim().to_string();
            key_value_map.insert(key, value);
        }
    }

    key_value_map
}

pub fn write_env_map(
    env_file_path: &PathBuf,
    key_value_map: &HashMap<String, String>,
) -> Result<(), String> {
    if let Some(parent) = env_file_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create directory: {error}"))?;
    }

    let mut sorted_keys: Vec<&String> = key_value_map.keys().collect();
    sorted_keys.sort();

    let file_contents: String = sorted_keys
        .iter()
        .map(|key| format!("{}={}\n", key, key_value_map[*key]))
        .collect();

    std::fs::write(env_file_path, file_contents)
        .map_err(|error| format!("failed to write .env file: {error}"))
}

pub fn save_secret_to_env_file(env_variable_name: &str, secret_value: &str) -> Result<(), String> {
    let env_file_path = resolve_env_file_path();
    let mut key_value_map = read_env_map(&env_file_path);
    key_value_map.insert(env_variable_name.to_string(), secret_value.to_string());
    write_env_map(&env_file_path, &key_value_map)
}
