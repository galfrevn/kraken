# `kraken replay` — Task Replay

## Summary

Add a `kraken replay <task-id>` command that re-executes a previously run task with the same prompt, agent, and optionally modified parameters. Useful for debugging failed tasks, testing fixes, and iterating on prompts.

## Motivation

When a task fails, the user often wants to try again after fixing the underlying issue (a bug in the code, a missing dependency, etc.). Today they must manually copy the prompt and re-schedule. Replay makes this a single command and preserves the link to the original task for comparison.

## Current State

- `kraken task retry <id>` exists in the CLI — retries a failed task with the same prompt.
- `POST /api/tasks/{id}/retry` exists in the HTTP API.
- But retry only works for failed tasks and doesn't allow modifying parameters.
- No concept of "replaying" a completed task or comparing runs.

## Implementation

### CLI Command

Add to `src/cli/task_cmd.rs`:

```rust
/// Replay a task (re-run with same or modified parameters)
#[derive(Args)]
struct ReplayArgs {
    /// Task ID to replay
    task_id: String,

    /// Override the prompt
    #[arg(long)]
    prompt: Option<String>,

    /// Override the agent
    #[arg(long)]
    agent: Option<String>,

    /// Override priority
    #[arg(long)]
    priority: Option<i32>,

    /// Add a note explaining why this replay was triggered
    #[arg(long)]
    note: Option<String>,

    /// Dry run — show what would be scheduled without executing
    #[arg(long)]
    dry_run: bool,

    /// Compare output with original task after completion
    #[arg(long)]
    compare: bool,
}
```

### HTTP API

```rust
// POST /api/tasks/{id}/replay
#[derive(Deserialize)]
struct ReplayRequestBody {
    prompt_override: Option<String>,
    agent_override: Option<String>,
    priority_override: Option<i32>,
    note: Option<String>,
}

async fn replay_task(
    Path(task_id): Path<String>,
    State(state): State<HttpApiState>,
    Json(body): Json<ReplayRequestBody>,
) -> impl IntoResponse {
    // 1. Load original task
    let original = state.task_store.get_task(&task_id)?;

    // 2. Create new task based on original
    let new_task = Task {
        id: generate_id(),
        name: body.prompt_override.unwrap_or(original.name.clone()),
        agent: body.agent_override.unwrap_or(original.agent.clone()),
        priority: body.priority_override.unwrap_or(original.priority),
        status: "pending".to_string(),
        replay_of: Some(task_id.clone()),  // NEW field: link to original
        note: body.note,
        ..Default::default()
    };

    // 3. Insert and return
    state.task_store.insert_task(&new_task)?;

    (StatusCode::CREATED, json!({
        "id": new_task.id,
        "replay_of": task_id,
        "prompt": new_task.name,
        "agent": new_task.agent,
    }))
}
```

### Database Changes

Add columns to the `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN replay_of TEXT;     -- ID of original task
ALTER TABLE tasks ADD COLUMN note TEXT;           -- optional replay note
ALTER TABLE tasks ADD COLUMN replay_count INTEGER DEFAULT 0;  -- how many times replayed
```

### Comparison Feature

When `--compare` is set, after the replay task completes, show a diff of outputs:

```rust
async fn compare_tasks(original_id: &str, replay_id: &str, store: &TaskStore) -> String {
    let original = store.get_task(original_id).unwrap();
    let replay = store.get_task(replay_id).unwrap();

    let mut comparison = String::new();
    comparison.push_str(&format!("Original ({}): {} — {}\n", original.id, original.status, original.exit_code));
    comparison.push_str(&format!("Replay   ({}): {} — {}\n", replay.id, replay.status, replay.exit_code));
    comparison.push_str(&format!("\nDuration: {} → {}\n", original.duration(), replay.duration()));

    if original.status != replay.status {
        comparison.push_str(&format!("\nStatus changed: {} → {}\n", original.status, replay.status));
    }

    // Diff outputs
    if original.output != replay.output {
        comparison.push_str("\nOutput diff:\n");
        comparison.push_str(&text_diff(&original.output.unwrap_or_default(), &replay.output.unwrap_or_default()));
    }

    comparison
}
```

### CLI Output

```
$ kraken replay abc123

  Replaying task abc123
  ─────────────────────
  Original prompt: "Run all tests and fix any failures"
  Agent: build
  Original status: failed (exit code 1)

  New task created: def456
  Status: pending

$ kraken replay abc123 --prompt "Run all tests and fix failures, ignore snapshot tests" --compare

  Replaying task abc123 (modified prompt)
  ───────────────────────────────────────
  Original: "Run all tests and fix any failures"
  Modified: "Run all tests and fix failures, ignore snapshot tests"

  New task created: ghi789
  Waiting for completion...

  Comparison:
  Original (abc123): failed — exit code 1 (duration: 2m 34s)
  Replay   (ghi789): completed — exit code 0 (duration: 1m 12s)

  Status changed: failed → completed ✓
```

## Dependencies on Other Roadmap Items

- **Audit log** (016): Replay events should be audit-logged with the link to the original.
- **Telemetry** (015): Track replay success rates (do replays succeed more often than original runs?).
