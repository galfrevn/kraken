use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use tracing::{info, warn};

const TASK_ID_PREFIX_LENGTH: usize = 8;
const MAX_BRANCH_NAME_LENGTH: usize = 50;
const SECONDS_PER_DAY: u64 = 24 * 60 * 60;

pub struct WorktreeInfo {
    pub worktree_path: PathBuf,
    #[allow(dead_code)]
    pub branch_name: String,
    #[allow(dead_code)]
    pub task_id_short: String,
}

pub struct WorktreeManager {
    repository_root: PathBuf,
    branch_prefix: String,
}

impl WorktreeManager {
    pub fn new(repository_root: &Path, branch_prefix: &str) -> Self {
        Self {
            repository_root: repository_root.to_path_buf(),
            branch_prefix: branch_prefix.to_string(),
        }
    }

    pub fn create_worktree(&self, task_id: &str, task_name: &str) -> Result<WorktreeInfo, String> {
        let task_id_short = &task_id[..task_id.len().min(TASK_ID_PREFIX_LENGTH)];
        let sanitized_task_name = sanitize_branch_name(task_name);
        let branch_name = format!(
            "{}{}-{}",
            self.branch_prefix, sanitized_task_name, task_id_short
        );
        let worktree_path = self
            .repository_root
            .join(".kraken-worktrees")
            .join(format!("kraken-task-{}", task_id_short));

        let git_worktree_add_output = Command::new("git")
            .args(["worktree", "add"])
            .arg(&worktree_path)
            .args(["-b", &branch_name])
            .current_dir(&self.repository_root)
            .output()
            .map_err(|execution_error| {
                format!(
                    "failed to execute 'git worktree add' for task '{}': {}",
                    task_id, execution_error
                )
            })?;

        if !git_worktree_add_output.status.success() {
            let stderr_text = String::from_utf8_lossy(&git_worktree_add_output.stderr);
            return Err(format!(
                "git worktree add failed for task '{}': {}",
                task_id,
                stderr_text.trim()
            ));
        }

        info!(
            task_id = task_id,
            branch_name = %branch_name,
            worktree_path = %worktree_path.display(),
            "created git worktree for task"
        );

        Ok(WorktreeInfo {
            worktree_path,
            branch_name,
            task_id_short: task_id_short.to_string(),
        })
    }

    pub fn remove_worktree(&self, worktree_path: &Path) -> Result<(), String> {
        let git_worktree_remove_output = Command::new("git")
            .args(["worktree", "remove"])
            .arg(worktree_path)
            .arg("--force")
            .current_dir(&self.repository_root)
            .output()
            .map_err(|execution_error| {
                format!(
                    "failed to execute 'git worktree remove' for '{}': {}",
                    worktree_path.display(),
                    execution_error
                )
            })?;

        if !git_worktree_remove_output.status.success() {
            let stderr_text = String::from_utf8_lossy(&git_worktree_remove_output.stderr);
            warn!(
                worktree_path = %worktree_path.display(),
                stderr = %stderr_text.trim(),
                "git worktree remove failed, attempting manual cleanup"
            );
        }

        if worktree_path.exists() {
            fs::remove_dir_all(worktree_path).map_err(|removal_error| {
                format!(
                    "failed to remove worktree directory '{}': {}",
                    worktree_path.display(),
                    removal_error
                )
            })?;
        }

        info!(
            worktree_path = %worktree_path.display(),
            "removed git worktree"
        );

        Ok(())
    }

    pub fn reset_worktree(&self, worktree_path: &Path) -> Result<(), String> {
        let git_checkout_output = Command::new("git")
            .args(["checkout", "."])
            .current_dir(worktree_path)
            .output()
            .map_err(|execution_error| {
                format!(
                    "failed to execute 'git checkout .' in '{}': {}",
                    worktree_path.display(),
                    execution_error
                )
            })?;

        if !git_checkout_output.status.success() {
            let stderr_text = String::from_utf8_lossy(&git_checkout_output.stderr);
            return Err(format!(
                "git checkout . failed in '{}': {}",
                worktree_path.display(),
                stderr_text.trim()
            ));
        }

        let git_clean_output = Command::new("git")
            .args(["clean", "-fd"])
            .current_dir(worktree_path)
            .output()
            .map_err(|execution_error| {
                format!(
                    "failed to execute 'git clean -fd' in '{}': {}",
                    worktree_path.display(),
                    execution_error
                )
            })?;

        if !git_clean_output.status.success() {
            let stderr_text = String::from_utf8_lossy(&git_clean_output.stderr);
            return Err(format!(
                "git clean -fd failed in '{}': {}",
                worktree_path.display(),
                stderr_text.trim()
            ));
        }

        info!(
            worktree_path = %worktree_path.display(),
            "reset git worktree to clean state"
        );

        Ok(())
    }

    #[allow(dead_code)]
    pub fn list_worktrees(&self) -> Vec<WorktreeInfo> {
        let git_worktree_list_output = match Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(&self.repository_root)
            .output()
        {
            Ok(output) => output,
            Err(execution_error) => {
                warn!(
                    error = %execution_error,
                    "failed to execute 'git worktree list'"
                );
                return Vec::new();
            }
        };

        if !git_worktree_list_output.status.success() {
            return Vec::new();
        }

        let raw_output = String::from_utf8_lossy(&git_worktree_list_output.stdout);
        parse_porcelain_worktree_output(&raw_output)
    }

    #[allow(dead_code)]
    pub fn cleanup_stale_worktrees(&self, maximum_age_days: u32) -> u32 {
        let all_worktrees = self.list_worktrees();
        let maximum_age_duration =
            std::time::Duration::from_secs(u64::from(maximum_age_days) * SECONDS_PER_DAY);
        let mut removed_worktree_count: u32 = 0;

        for worktree_info in &all_worktrees {
            if !worktree_info
                .worktree_path
                .to_string_lossy()
                .contains("kraken-task-")
            {
                continue;
            }

            let worktree_directory_age = match fs::metadata(&worktree_info.worktree_path)
                .and_then(|metadata| metadata.modified())
                .and_then(|modified_time| {
                    SystemTime::now()
                        .duration_since(modified_time)
                        .map_err(std::io::Error::other)
                }) {
                Ok(age) => age,
                Err(_) => continue,
            };

            if worktree_directory_age > maximum_age_duration {
                info!(
                    worktree_path = %worktree_info.worktree_path.display(),
                    age_days = worktree_directory_age.as_secs() / 86400,
                    "removing stale worktree"
                );

                if self.remove_worktree(&worktree_info.worktree_path).is_ok() {
                    removed_worktree_count += 1;
                }
            }
        }

        if removed_worktree_count > 0 {
            info!(
                removed_count = removed_worktree_count,
                "stale worktree cleanup complete"
            );
        }

        removed_worktree_count
    }
}

fn sanitize_branch_name(raw_name: &str) -> String {
    let lowercased_name = raw_name.to_lowercase();

    let sanitized_characters: String = lowercased_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();

    let collapsed_hyphens = sanitized_characters
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<&str>>()
        .join("-");

    let trimmed_name = collapsed_hyphens.trim_matches('-').to_string();

    if trimmed_name.len() > MAX_BRANCH_NAME_LENGTH {
        trimmed_name[..MAX_BRANCH_NAME_LENGTH]
            .trim_end_matches('-')
            .to_string()
    } else {
        trimmed_name
    }
}

#[allow(dead_code)]
fn parse_porcelain_worktree_output(raw_output: &str) -> Vec<WorktreeInfo> {
    let mut parsed_worktrees = Vec::new();
    let mut current_worktree_path: Option<PathBuf> = None;
    let mut current_branch_name: Option<String> = None;

    for line in raw_output.lines() {
        if let Some(path_value) = line.strip_prefix("worktree ") {
            current_worktree_path = Some(PathBuf::from(path_value));
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            let extracted_branch_name =
                branch_ref.strip_prefix("refs/heads/").unwrap_or(branch_ref);
            current_branch_name = Some(extracted_branch_name.to_string());
        } else if line.is_empty() {
            if let (Some(worktree_path), Some(branch_name)) =
                (current_worktree_path.take(), current_branch_name.take())
            {
                let task_id_short = extract_task_id_short_from_path(&worktree_path);
                parsed_worktrees.push(WorktreeInfo {
                    worktree_path,
                    branch_name,
                    task_id_short,
                });
            } else {
                current_worktree_path = None;
                current_branch_name = None;
            }
        }
    }

    if let (Some(worktree_path), Some(branch_name)) =
        (current_worktree_path.take(), current_branch_name.take())
    {
        let task_id_short = extract_task_id_short_from_path(&worktree_path);
        parsed_worktrees.push(WorktreeInfo {
            worktree_path,
            branch_name,
            task_id_short,
        });
    }

    parsed_worktrees
}

#[allow(dead_code)]
fn extract_task_id_short_from_path(worktree_path: &Path) -> String {
    worktree_path
        .file_name()
        .and_then(|directory_name| directory_name.to_str())
        .and_then(|directory_name_str| directory_name_str.strip_prefix("kraken-task-"))
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_branch_name_replaces_spaces_with_hyphens() {
        assert_eq!(sanitize_branch_name("my task name"), "my-task-name");
    }

    #[test]
    fn test_sanitize_branch_name_converts_to_lowercase() {
        assert_eq!(sanitize_branch_name("My Task NAME"), "my-task-name");
    }

    #[test]
    fn test_sanitize_branch_name_replaces_special_characters() {
        assert_eq!(
            sanitize_branch_name("fix: bug #123 (urgent!)"),
            "fix-bug-123-urgent"
        );
    }

    #[test]
    fn test_sanitize_branch_name_collapses_consecutive_hyphens() {
        assert_eq!(
            sanitize_branch_name("hello---world   test"),
            "hello-world-test"
        );
    }

    #[test]
    fn test_sanitize_branch_name_truncates_to_50_characters() {
        let very_long_name = "a".repeat(100);
        let sanitized = sanitize_branch_name(&very_long_name);
        assert!(sanitized.len() <= 50);
    }

    #[test]
    fn test_sanitize_branch_name_does_not_end_with_hyphen_after_truncation() {
        let name_that_truncates_at_hyphen = format!("{}-more-stuff", "a".repeat(49));
        let sanitized = sanitize_branch_name(&name_that_truncates_at_hyphen);
        assert!(!sanitized.ends_with('-'));
        assert!(sanitized.len() <= 50);
    }

    #[test]
    fn test_sanitize_branch_name_strips_leading_and_trailing_hyphens() {
        assert_eq!(sanitize_branch_name("--hello--"), "hello");
    }

    #[test]
    fn test_sanitize_branch_name_handles_empty_string() {
        assert_eq!(sanitize_branch_name(""), "");
    }

    #[test]
    fn test_extract_task_id_short_from_valid_path() {
        let path = PathBuf::from("/repo/.kraken-worktrees/kraken-task-abcd1234");
        assert_eq!(extract_task_id_short_from_path(&path), "abcd1234");
    }

    #[test]
    fn test_extract_task_id_short_from_non_matching_path() {
        let path = PathBuf::from("/repo/some-other-directory");
        assert_eq!(extract_task_id_short_from_path(&path), "");
    }

    #[test]
    fn test_parse_porcelain_worktree_output_with_multiple_entries() {
        let porcelain_output = "\
worktree /home/user/repo
branch refs/heads/main
HEAD abc123

worktree /home/user/repo/.kraken-worktrees/kraken-task-12345678
branch refs/heads/kraken/fix-bug-12345678
HEAD def456

worktree /home/user/repo/.kraken-worktrees/kraken-task-87654321
branch refs/heads/kraken/add-feature-87654321
HEAD ghi789
";

        let parsed_results = parse_porcelain_worktree_output(porcelain_output);

        assert_eq!(parsed_results.len(), 3);

        assert_eq!(parsed_results[0].branch_name, "main");
        assert_eq!(
            parsed_results[0].worktree_path,
            PathBuf::from("/home/user/repo")
        );

        assert_eq!(parsed_results[1].branch_name, "kraken/fix-bug-12345678");
        assert_eq!(parsed_results[1].task_id_short, "12345678");

        assert_eq!(parsed_results[2].branch_name, "kraken/add-feature-87654321");
        assert_eq!(parsed_results[2].task_id_short, "87654321");
    }

    #[test]
    fn test_parse_porcelain_worktree_output_with_empty_input() {
        let parsed_results = parse_porcelain_worktree_output("");
        assert!(parsed_results.is_empty());
    }

    #[test]
    fn test_parse_porcelain_worktree_output_handles_bare_worktree() {
        let porcelain_output = "\
worktree /home/user/repo
branch refs/heads/main
HEAD abc123

worktree /home/user/repo/.kraken-worktrees/kraken-task-aabbccdd
bare

";

        let parsed_results = parse_porcelain_worktree_output(porcelain_output);
        // The bare entry has no branch, so it should be skipped
        assert_eq!(parsed_results.len(), 1);
        assert_eq!(parsed_results[0].branch_name, "main");
    }

    #[test]
    fn test_worktree_manager_new_stores_configuration() {
        let repository_root = PathBuf::from("/tmp/test-repo");
        let manager = WorktreeManager::new(&repository_root, "kraken/");

        assert_eq!(manager.repository_root, repository_root);
        assert_eq!(manager.branch_prefix, "kraken/");
    }

    #[test]
    fn test_create_worktree_in_real_git_repo() {
        let temporary_directory =
            std::env::temp_dir().join(format!("kraken_worktree_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temporary_directory).expect("should create temp dir");

        let git_init_output = Command::new("git")
            .args(["init"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should run git init");
        assert!(git_init_output.status.success(), "git init failed");

        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git email");
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git name");

        let initial_file_path = temporary_directory.join("README.md");
        fs::write(&initial_file_path, "initial").expect("should write file");
        Command::new("git")
            .args(["add", "."])
            .current_dir(&temporary_directory)
            .output()
            .expect("should stage files");
        Command::new("git")
            .args(["commit", "-m", "initial commit"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should create initial commit");

        let worktree_manager = WorktreeManager::new(&temporary_directory, "kraken/");

        let created_worktree = worktree_manager
            .create_worktree("abcdef12-3456-7890-abcd-ef1234567890", "Fix login bug")
            .expect("should create worktree");

        assert_eq!(created_worktree.task_id_short, "abcdef12");
        assert_eq!(
            created_worktree.branch_name,
            "kraken/fix-login-bug-abcdef12"
        );
        assert!(created_worktree.worktree_path.exists());
        assert!(
            created_worktree
                .worktree_path
                .to_string_lossy()
                .contains("kraken-task-abcdef12")
        );

        let listed_worktrees = worktree_manager.list_worktrees();
        let matching_worktree = listed_worktrees
            .iter()
            .find(|worktree| worktree.task_id_short == "abcdef12");
        assert!(matching_worktree.is_some());

        worktree_manager
            .remove_worktree(&created_worktree.worktree_path)
            .expect("should remove worktree");
        assert!(!created_worktree.worktree_path.exists());

        let _ = fs::remove_dir_all(&temporary_directory);
    }

    #[test]
    fn test_reset_worktree_in_real_git_repo() {
        let temporary_directory = std::env::temp_dir().join(format!(
            "kraken_worktree_reset_test_{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&temporary_directory).expect("should create temp dir");

        Command::new("git")
            .args(["init"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should run git init");
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git email");
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git name");

        let initial_file_path = temporary_directory.join("file.txt");
        fs::write(&initial_file_path, "original content").expect("should write file");
        Command::new("git")
            .args(["add", "."])
            .current_dir(&temporary_directory)
            .output()
            .expect("should stage files");
        Command::new("git")
            .args(["commit", "-m", "initial commit"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should create initial commit");

        let worktree_manager = WorktreeManager::new(&temporary_directory, "kraken/");

        let created_worktree = worktree_manager
            .create_worktree("reset123-4567-8901-abcd-ef1234567890", "reset test")
            .expect("should create worktree");

        let tracked_file_in_worktree = created_worktree.worktree_path.join("file.txt");
        fs::write(&tracked_file_in_worktree, "modified content").expect("should modify file");
        let untracked_file_in_worktree = created_worktree.worktree_path.join("untracked.txt");
        fs::write(&untracked_file_in_worktree, "untracked").expect("should create untracked file");

        worktree_manager
            .reset_worktree(&created_worktree.worktree_path)
            .expect("should reset worktree");

        let restored_content =
            fs::read_to_string(&tracked_file_in_worktree).expect("should read file");
        assert_eq!(restored_content, "original content");
        assert!(!untracked_file_in_worktree.exists());

        worktree_manager
            .remove_worktree(&created_worktree.worktree_path)
            .expect("should remove worktree");
        let _ = fs::remove_dir_all(&temporary_directory);
    }

    #[test]
    fn test_cleanup_stale_worktrees_removes_old_worktrees() {
        let temporary_directory = std::env::temp_dir().join(format!(
            "kraken_worktree_cleanup_test_{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&temporary_directory).expect("should create temp dir");

        Command::new("git")
            .args(["init"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should run git init");
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git email");
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git name");

        let initial_file_path = temporary_directory.join("README.md");
        fs::write(&initial_file_path, "initial").expect("should write file");
        Command::new("git")
            .args(["add", "."])
            .current_dir(&temporary_directory)
            .output()
            .expect("should stage files");
        Command::new("git")
            .args(["commit", "-m", "initial commit"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should create initial commit");

        let worktree_manager = WorktreeManager::new(&temporary_directory, "kraken/");

        let created_worktree = worktree_manager
            .create_worktree("stale000-1111-2222-3333-444455556666", "stale task")
            .expect("should create worktree");

        let removed_count = worktree_manager.cleanup_stale_worktrees(0);
        assert_eq!(removed_count, 1);
        assert!(!created_worktree.worktree_path.exists());

        let _ = fs::remove_dir_all(&temporary_directory);
    }

    #[test]
    fn test_cleanup_stale_worktrees_keeps_recent_worktrees() {
        let temporary_directory = std::env::temp_dir().join(format!(
            "kraken_worktree_keep_test_{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&temporary_directory).expect("should create temp dir");

        Command::new("git")
            .args(["init"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should run git init");
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git email");
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git name");

        let initial_file_path = temporary_directory.join("README.md");
        fs::write(&initial_file_path, "initial").expect("should write file");
        Command::new("git")
            .args(["add", "."])
            .current_dir(&temporary_directory)
            .output()
            .expect("should stage files");
        Command::new("git")
            .args(["commit", "-m", "initial commit"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should create initial commit");

        let worktree_manager = WorktreeManager::new(&temporary_directory, "kraken/");

        let created_worktree = worktree_manager
            .create_worktree("fresh000-1111-2222-3333-444455556666", "fresh task")
            .expect("should create worktree");

        let removed_count = worktree_manager.cleanup_stale_worktrees(30);
        assert_eq!(removed_count, 0);
        assert!(created_worktree.worktree_path.exists());

        worktree_manager
            .remove_worktree(&created_worktree.worktree_path)
            .expect("should remove worktree");
        let _ = fs::remove_dir_all(&temporary_directory);
    }

    #[test]
    fn test_create_worktree_with_duplicate_branch_fails() {
        let temporary_directory =
            std::env::temp_dir().join(format!("kraken_worktree_dup_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temporary_directory).expect("should create temp dir");

        Command::new("git")
            .args(["init"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should run git init");
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git email");
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should configure git name");

        let initial_file_path = temporary_directory.join("README.md");
        fs::write(&initial_file_path, "initial").expect("should write file");
        Command::new("git")
            .args(["add", "."])
            .current_dir(&temporary_directory)
            .output()
            .expect("should stage files");
        Command::new("git")
            .args(["commit", "-m", "initial commit"])
            .current_dir(&temporary_directory)
            .output()
            .expect("should create initial commit");

        let worktree_manager = WorktreeManager::new(&temporary_directory, "kraken/");

        let _first_worktree = worktree_manager
            .create_worktree("same0000-1111-2222-3333-444455556666", "duplicate test")
            .expect("should create first worktree");

        let duplicate_result = worktree_manager
            .create_worktree("same0000-1111-2222-3333-444455556666", "duplicate test");

        assert!(duplicate_result.is_err());

        worktree_manager
            .remove_worktree(&_first_worktree.worktree_path)
            .expect("should remove worktree");
        let _ = fs::remove_dir_all(&temporary_directory);
    }
}
