# Workflow / Pipeline Engine

## Summary

Add a workflow engine to the daemon that enables multi-step task pipelines with dependencies, conditional execution, failure handling, and data passing between steps. Today each task is an isolated unit — workflows allow composing tasks into sequences and DAGs.

## Motivation

Real-world automation often requires multiple steps: run tests → build → deploy → smoke test. Today users must either encode the entire workflow in a single prompt (fragile, context window limits) or schedule separate tasks and hope they run in order. A proper workflow engine makes this declarative and reliable.

## Current State

- The daemon orchestrator (`src/orchestrator/mod.rs`) manages independent tasks with priority-based scheduling.
- Tasks have no dependency concept — each is picked up when a worker slot is free.
- `TaskStore` (`src/db/tasks.rs`) stores individual tasks with status, priority, output, error.
- Triggers can schedule individual tasks, not sequences.

## Architecture

### New Daemon Module: `src/workflows/`

```
src/workflows/
  mod.rs          -- public API, workflow lifecycle
  engine.rs       -- execution engine, step scheduling
  types.rs        -- workflow, step, condition definitions
  store.rs        -- SQLite persistence for workflows
```

### Data Model

```rust
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub status: WorkflowStatus,            // Pending, Running, Completed, Failed, Cancelled
    pub steps: Vec<WorkflowStep>,
    pub context: serde_json::Value,         // shared data between steps
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub triggered_by: Option<String>,       // trigger name or "manual"
}

pub struct WorkflowStep {
    pub id: String,
    pub name: String,
    pub task_prompt: String,                // prompt template with {{variable}} interpolation
    pub agent: String,                      // default: "build"
    pub depends_on: Vec<String>,            // step IDs that must complete first
    pub condition: Option<StepCondition>,    // conditional execution
    pub on_failure: FailureAction,          // Stop, Continue, Retry(n)
    pub timeout_seconds: Option<u64>,
    pub status: StepStatus,
    pub task_id: Option<String>,            // linked task ID when scheduled
    pub output: Option<String>,
    pub error: Option<String>,
}

pub enum StepCondition {
    Always,
    OnSuccess(String),                      // run only if step X succeeded
    OnFailure(String),                      // run only if step X failed
    Expression(String),                     // evaluate against workflow context
}

pub enum FailureAction {
    Stop,                                   // stop the entire workflow
    Continue,                               // mark step as failed, continue
    Retry { max_attempts: u32, backoff_seconds: u64 },
}
```

### Configuration (kraken.jsonc)

```jsonc
{
  "workflows": {
    "deploy": {
      "steps": [
        {
          "name": "run-tests",
          "task": "Run all tests in the project. Report pass/fail counts.",
          "on_failure": "stop"
        },
        {
          "name": "build",
          "task": "Build the production bundle.",
          "depends_on": ["run-tests"]
        },
        {
          "name": "deploy-staging",
          "task": "Deploy the build to staging environment.",
          "depends_on": ["build"]
        },
        {
          "name": "smoke-test",
          "task": "Run smoke tests against the staging environment at {{context.staging_url}}.",
          "depends_on": ["deploy-staging"],
          "on_failure": { "retry": { "max_attempts": 2, "backoff_seconds": 30 } }
        },
        {
          "name": "notify-failure",
          "task": "Summarize what went wrong in the deployment pipeline.",
          "condition": { "on_failure": "deploy-staging" },
          "on_failure": "continue"
        }
      ]
    },
    "review-and-merge": {
      "steps": [
        {
          "name": "review",
          "task": "Review PR #{{context.pr_number}} thoroughly. Check for bugs, style, performance.",
          "agent": "plan"
        },
        {
          "name": "run-tests",
          "task": "Run the test suite to verify PR #{{context.pr_number}} doesn't break anything.",
          "depends_on": ["review"],
          "condition": { "on_success": "review" }
        }
      ]
    }
  }
}
```

### Execution Engine

```rust
impl WorkflowEngine {
    pub async fn execute(&self, workflow_id: &str) {
        loop {
            let ready_steps = self.get_ready_steps(workflow_id);
            if ready_steps.is_empty() {
                if self.all_steps_finished(workflow_id) { break; }
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }

            for step in ready_steps {
                if !self.evaluate_condition(&step) {
                    self.mark_step_skipped(&step);
                    continue;
                }

                let prompt = self.interpolate_prompt(&step.task_prompt, &workflow.context);
                let task_id = self.schedule_task(prompt, &step.agent).await;
                self.link_step_to_task(&step.id, &task_id);
            }

            // Wait for any in-progress step to complete
            self.wait_for_step_completion(workflow_id).await;
        }
    }

    fn get_ready_steps(&self, workflow_id: &str) -> Vec<WorkflowStep> {
        // Steps where all depends_on are completed/skipped and step is still pending
    }

    fn interpolate_prompt(&self, template: &str, context: &serde_json::Value) -> String {
        // Replace {{context.key}} with values from the workflow context
    }
}
```

### Variable Passing Between Steps

When a step completes, its output is stored in the workflow context:

```rust
// After step "run-tests" completes with output "All 120 tests passed":
workflow.context["steps"]["run-tests"]["output"] = "All 120 tests passed";
workflow.context["steps"]["run-tests"]["status"] = "completed";
workflow.context["steps"]["run-tests"]["exit_code"] = 0;
```

Subsequent steps can reference this via `{{steps.run-tests.output}}` in their prompt templates.

### SQLite Storage

```sql
CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    context TEXT,                            -- JSON
    config TEXT,                             -- original workflow definition JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    triggered_by TEXT
);

CREATE TABLE workflow_steps (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    name TEXT NOT NULL,
    task_prompt TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT 'build',
    depends_on TEXT,                         -- JSON array of step IDs
    condition TEXT,                          -- JSON
    on_failure TEXT NOT NULL DEFAULT 'stop',
    timeout_seconds INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    task_id TEXT,
    output TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

### HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workflows` | `GET` | List workflows |
| `/api/workflows` | `POST` | Start a workflow (`{ name: "deploy", context: { ... } }`) |
| `/api/workflows/{id}` | `GET` | Get workflow status with all steps |
| `/api/workflows/{id}/cancel` | `POST` | Cancel a running workflow |
| `/api/workflows/{id}/retry` | `POST` | Retry a failed workflow from the failed step |

### Trigger Integration

Triggers can start workflows instead of single tasks:

```jsonc
{
  "triggers": {
    "webhooks": [{
      "name": "github-push-main",
      "provider": "github",
      "events": [{
        "type": "push",
        "filter": ["ref equals 'refs/heads/main'"],
        "workflow": "deploy",
        "context": {
          "branch": "{{event.ref}}",
          "commit": "{{event.after}}"
        }
      }]
    }]
  }
}
```

### CLI

```bash
kraken workflow list                              # list workflow definitions
kraken workflow start deploy --context '{"env":"staging"}'  # start a workflow
kraken workflow status <workflow-id>               # show steps and progress
kraken workflow cancel <workflow-id>
kraken workflow retry <workflow-id>
```

## Dependencies on Other Roadmap Items

- **Approval gates** (not in this roadmap): Workflows are the natural place for approval steps ("pause until human approves").
- **Notifications**: The workflow engine should send notifications on workflow completion/failure, not just per-step.
