# `kraken watch --test` — Auto-Fix Test Mode

## Summary

Add a `kraken watch --test` mode that watches for file changes, runs the test suite automatically, and if tests fail, uses the agent to diagnose and fix the failures. A tight feedback loop: save file → tests run → agent fixes failures → tests pass.

## Motivation

TDD with an AI agent: the developer writes tests, the agent makes them pass. Or the developer modifies code, and if tests break, the agent suggests/applies fixes automatically. This combines the existing file watcher capability with the agent's problem-solving ability.

## Current State

- File watchers exist in the daemon (`src/watcher.rs`, `src/triggers/watcher_trigger.rs`).
- Watchers can trigger tasks with `{{event.path}}` template.
- No test runner integration or test-specific logic exists.
- The agent can run tests via the `bash` tool, but there's no automated loop.

## Implementation

### CLI Command

```rust
/// Watch mode with test integration
#[derive(Args)]
struct WatchArgs {
    /// Run tests on file changes and auto-fix failures
    #[arg(long)]
    test: bool,

    /// Test command to run (auto-detected if not provided)
    #[arg(long)]
    test_cmd: Option<String>,

    /// Paths to watch (default: src, lib, test, tests)
    #[arg(long)]
    paths: Option<Vec<String>>,

    /// Max auto-fix attempts per failure
    #[arg(long, default_value = "3")]
    max_attempts: u32,

    /// Only diagnose, don't auto-fix
    #[arg(long)]
    diagnose_only: bool,

    /// Run tests before watching (verify initial state)
    #[arg(long)]
    initial_run: bool,
}
```

### Test Runner Detection

```rust
fn detect_test_command(repo_path: &Path) -> Option<String> {
    // Check package.json for test script
    let package_json = repo_path.join("package.json");
    if package_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&package_json) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if parsed["scripts"]["test"].is_string() {
                    // Check for bun, npm, etc.
                    if repo_path.join("bun.lockb").exists() {
                        return Some("bun test".to_string());
                    }
                    return Some("npm test".to_string());
                }
            }
        }
    }

    // Check Cargo.toml
    if repo_path.join("Cargo.toml").exists() {
        return Some("cargo test".to_string());
    }

    // Check for pytest
    if repo_path.join("pytest.ini").exists() || repo_path.join("pyproject.toml").exists() {
        return Some("python -m pytest".to_string());
    }

    // Check for Go
    if repo_path.join("go.mod").exists() {
        return Some("go test ./...".to_string());
    }

    None
}
```

### Watch-Test Loop

```rust
async fn run_watch_test(args: WatchArgs, daemon_url: &str) {
    let test_cmd = args.test_cmd
        .or_else(|| detect_test_command(Path::new(".")))
        .expect("Could not detect test command. Use --test-cmd to specify.");

    println!("Watch-test mode");
    println!("  Test command: {}", test_cmd);
    println!("  Max fix attempts: {}", args.max_attempts);
    println!("  Watching for changes...\n");

    if args.initial_run {
        run_test_cycle(&test_cmd, daemon_url, &args).await;
    }

    // Set up file watcher
    let (tx, mut rx) = tokio::sync::mpsc::channel(100);
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.try_send(event);
    }).unwrap();

    let watch_paths = args.paths.unwrap_or_else(|| {
        vec!["src", "lib", "test", "tests", "spec"]
            .into_iter()
            .filter(|p| Path::new(p).exists())
            .map(String::from)
            .collect()
    });

    for path in &watch_paths {
        watcher.watch(Path::new(path), RecursiveMode::Recursive).ok();
    }

    // Debounced event loop
    let mut debounce_timer = None;
    loop {
        tokio::select! {
            Some(_event) = rx.recv() => {
                debounce_timer = Some(tokio::time::sleep(Duration::from_millis(500)));
            }
            _ = async { debounce_timer.as_mut().unwrap().await }, if debounce_timer.is_some() => {
                debounce_timer = None;
                run_test_cycle(&test_cmd, daemon_url, &args).await;
            }
        }
    }
}
```

### Test Cycle

```rust
async fn run_test_cycle(test_cmd: &str, daemon_url: &str, args: &WatchArgs) {
    println!("{}  Running tests...", chrono::Local::now().format("%H:%M:%S"));

    let output = Command::new("sh")
        .args(["-c", test_cmd])
        .output()
        .await
        .expect("Failed to run test command");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let exit_code = output.status.code().unwrap_or(-1);

    if exit_code == 0 {
        println!("  ✓ All tests passed\n");
        return;
    }

    println!("  ✗ Tests failed (exit code {})", exit_code);

    if args.diagnose_only {
        println!("  Diagnosis mode — not auto-fixing\n");
        // Schedule a plan-only task to diagnose
        schedule_diagnosis_task(daemon_url, test_cmd, &stdout, &stderr).await;
        return;
    }

    // Auto-fix loop
    for attempt in 1..=args.max_attempts {
        println!("  Attempt {}/{} to fix...", attempt, args.max_attempts);

        let prompt = format!(
            "The following test command failed:\n```\n{}\n```\n\nStdout:\n```\n{}\n```\n\nStderr:\n```\n{}\n```\n\nAnalyze the failure, identify the root cause, and fix the code. Do NOT modify the tests unless they are clearly wrong. After fixing, run the tests again to verify.",
            test_cmd,
            truncate(&stdout, 5000),
            truncate(&stderr, 5000),
        );

        let task_id = schedule_task(daemon_url, &prompt, "build").await;
        wait_for_task_completion(daemon_url, &task_id).await;

        // Re-run tests
        let retry_output = Command::new("sh")
            .args(["-c", test_cmd])
            .output()
            .await
            .expect("Failed to run test command");

        if retry_output.status.success() {
            println!("  ✓ Tests pass after fix (attempt {})\n", attempt);
            return;
        }

        println!("  Tests still failing after attempt {}", attempt);
    }

    println!("  ✗ Could not fix after {} attempts\n", args.max_attempts);
}
```

### Integration with Existing Triggers

This mode can also be configured declaratively in `kraken.jsonc` as a special watcher:

```jsonc
{
  "triggers": {
    "watchers": [{
      "name": "auto-test",
      "paths": ["./src", "./test"],
      "ignore": ["node_modules", ".git"],
      "debounceMs": 1000,
      "mode": "test",
      "testCommand": "bun test",
      "maxFixAttempts": 3,
      "task": "Tests failed after changes in {{event.path}}. Test output:\n{{test.output}}\n\nFix the code to make tests pass."
    }]
  }
}
```

## CLI Output

```
$ kraken watch --test

  Watch-test mode
    Test command: bun test (auto-detected)
    Max fix attempts: 3
    Watching: src/, test/

14:23:01  Running tests...
  ✓ All tests passed

14:23:45  Running tests...
  ✗ Tests failed (exit code 1)
  Attempt 1/3 to fix...
  → Task scheduled: abc123
  → Agent fixing: Modified src/utils/parser.ts (line 45: off-by-one error)
  Running tests...
  ✓ Tests pass after fix (attempt 1)

14:25:12  Running tests...
  ✓ All tests passed
```

## Dependencies on Other Roadmap Items

- **Streaming improvements** (019): Show agent progress while fixing.
- **Telemetry** (015): Track auto-fix success rate, average attempts needed.
- **Rate limiting** (018): Prevent infinite fix loops if tests can never pass.
