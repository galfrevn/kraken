# Workflow / Pipeline Engine

## Summary

Add a workflow engine to the daemon that enables multi-step task pipelines. Unlike traditional CI/CD tools where workflows are hardcoded in config, Kraken workflows are **agent-driven** — the LLM decomposes complex tasks into steps at runtime. The engine provides infrastructure for tracking, executing, and coordinating those steps. Users can also ask the agent to save recurring workflows as reusable templates.

## Motivation

**Why not just a single task?**
A single task with a complex prompt works for many things, but breaks down when:
- The task is too large for one context window (refactor + test + deploy)
- Steps need different agents (plan for review, build for execution)
- Steps need different repos/workdirs
- You need failure isolation (test failure shouldn't corrupt the deploy step's context)
- You want progress visibility per step (not just "running..." for 20 minutes)

**Why not hardcoded workflows in JSONC?**
Kraken is an AI agent, not Jenkins. If the user has to manually write each step with exact prompts, dependencies, and conditions, they're doing the agent's job. The agent already knows how to decompose "deploy to staging and verify" into steps. What it lacks is infrastructure to track and coordinate those steps.

**The approach:** The workflow engine is infrastructure that the agent uses via tools. The agent creates workflows dynamically. Users can also ask the agent to save workflows as reusable templates for recurring operations.

## Current State

- The daemon orchestrator manages independent tasks with priority-based scheduling.
- Tasks have no dependency concept — each is picked up when a worker slot is free.
- `TaskStore` stores individual tasks with status, priority, output, error.
- Triggers can schedule individual tasks, not sequences.
- Channel slash commands (`/task`) create single tasks.

## Architecture

### New Daemon Module: `src/workflows/`

```
src/workflows/
  mod.rs          -- public API, workflow lifecycle
  engine.rs       -- execution engine, step scheduling, completion monitoring
  types.rs        -- Workflow, WorkflowStep, StepCondition, FailureAction
  store.rs        -- SQLite persistence
```

### Data Model

```rust
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub status: WorkflowStatus,            // Pending, Running, Completed, Failed, Cancelled
    pub context: serde_json::Value,         // shared data between steps (accumulated outputs)
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_by: String,                 // "agent", "template:deploy", "trigger:github-push"
    pub channel_type: Option<String>,       // for progress notifications
    pub channel_chat_id: Option<String>,
}

pub struct WorkflowStep {
    pub id: String,
    pub workflow_id: String,
    pub name: String,
    pub task_prompt: String,                // can include {{steps.prev.output}} interpolation
    pub agent: String,                      // "build", "plan"
    pub workdir: Option<String>,            // optional per-step repo/workdir override
    pub depends_on: Vec<String>,            // step names that must complete first
    pub on_failure: FailureAction,          // Stop, Continue, Retry(n)
    pub status: StepStatus,                 // Pending, Running, Completed, Failed, Skipped
    pub task_id: Option<String>,            // linked daemon task ID when scheduled
    pub output: Option<String>,             // captured from task output
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

pub enum FailureAction {
    Stop,                                   // stop the entire workflow
    Continue,                               // mark step as failed, continue to next
    Retry { max_attempts: u32 },
}

pub enum WorkflowStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

pub enum StepStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Skipped,
}
```

### How It Works: Agent-Driven Workflow Creation

The agent gets a new tool: `create_workflow`. When it receives a complex task, it decomposes it into steps:

```
User (via Telegram): /task deploy the new auth system to staging and verify it works

Agent receives the task and decides it needs multiple steps:

Tool call: create_workflow({
  name: "Deploy auth to staging",
  steps: [
    { name: "run-tests", prompt: "Run the full test suite in the auth-service repo", agent: "build", workdir: "~/code/auth-service" },
    { name: "build", prompt: "Build the docker image for auth-service", depends_on: ["run-tests"] },
    { name: "deploy", prompt: "Deploy auth-service to staging using the deploy script", depends_on: ["build"] },
    { name: "verify", prompt: "Run smoke tests against staging.example.com/auth/health", depends_on: ["deploy"], on_failure: "continue" }
  ],
  channel_type: "telegram",
  channel_chat_id: "7335759689"
})
```

The engine then:
1. Creates the workflow and steps in the database
2. Starts executing step by step (respecting depends_on)
3. Sends progress updates to the channel:
   ```
   Workflow "Deploy auth to staging" started (4 steps)
   ✓ Step 1/4: run-tests — passed
   ✓ Step 2/4: build — image built
   ⏳ Step 3/4: deploy — running...
   ✓ Step 3/4: deploy — deployed
   ✓ Step 4/4: verify — smoke tests passed
   ✅ Workflow complete
   ```
4. Each step creates a real daemon task via TaskStore
5. Step outputs are stored in workflow context for use by later steps

### Reusable Templates

The agent can also save workflow definitions as templates when asked:

```
User: "from now on, when I say 'deploy api', run tests, build, and deploy to staging"

Agent: saves template via save_workflow_template tool
```

Templates are stored in the database (not JSONC):

```rust
pub struct WorkflowTemplate {
    pub id: String,
    pub name: String,                       // "deploy-api"
    pub description: String,
    pub steps: Vec<WorkflowStepTemplate>,   // step definitions with {{context.var}} placeholders
    pub created_at: String,
}
```

Then when the user says `/task deploy api`, the agent recognizes the template and instantiates it. Or triggers can reference templates:

```jsonc
{
  "triggers": {
    "webhooks": [{
      "name": "github-push-main",
      "provider": "github",
      "events": [{
        "type": "push",
        "filter": ["ref equals 'refs/heads/main'"],
        "workflow": "deploy-api",
        "context": {
          "branch": "{{event.ref}}",
          "commit": "{{event.after}}"
        }
      }]
    }]
  }
}
```

### Execution Engine

```rust
impl WorkflowEngine {
    /// Main execution loop — runs as a background task in the daemon
    pub async fn run(&self) {
        loop {
            // Check all running workflows for steps that can be advanced
            let running = self.store.list_workflows_by_status(WorkflowStatus::Running).await;
            for workflow in running {
                self.advance_workflow(&workflow).await;
            }

            // Start any pending workflows
            let pending = self.store.list_workflows_by_status(WorkflowStatus::Pending).await;
            for workflow in pending {
                self.start_workflow(&workflow).await;
            }

            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    async fn advance_workflow(&self, workflow: &Workflow) {
        // 1. Check in-progress steps — have their linked tasks completed?
        for step in self.store.get_running_steps(workflow.id).await {
            if let Some(task) = self.task_store.get(&step.task_id).await {
                if task.status == "completed" {
                    self.complete_step(&step, &task.output).await;
                    self.update_context(workflow, &step, &task).await;
                    self.notify_progress(workflow, &step, "completed").await;
                } else if task.status == "failed" {
                    self.handle_step_failure(workflow, &step, &task).await;
                }
            }
        }

        // 2. Find steps whose dependencies are met → schedule them
        let ready = self.get_ready_steps(workflow).await;
        for step in ready {
            let prompt = self.interpolate(step.task_prompt, &workflow.context);
            let task_id = self.task_store.create_task(&prompt, &step.agent, step.workdir).await;
            self.store.link_step_to_task(&step.id, &task_id).await;
            self.notify_progress(workflow, &step, "started").await;
        }

        // 3. Check if workflow is done
        if self.all_steps_terminal(workflow).await {
            let has_failures = self.any_step_failed(workflow).await;
            let final_status = if has_failures { WorkflowStatus::Failed } else { WorkflowStatus::Completed };
            self.store.update_status(workflow.id, final_status).await;
            self.notify_completion(workflow, final_status).await;
        }
    }
}
```

### Variable Passing Between Steps

When a step completes, its output is stored in the workflow context automatically:

```json
{
  "steps": {
    "run-tests": {
      "status": "completed",
      "output": "All 120 tests passed (3.2s)",
      "exit_code": 0
    },
    "build": {
      "status": "completed",
      "output": "Image built: auth-service:v1.2.3",
      "exit_code": 0
    }
  }
}
```

Subsequent step prompts can reference previous outputs via `{{steps.build.output}}`. The engine interpolates these before creating the task.

Steps in the same workflow share the same git worktree, so file-based communication (writing a result to a file, reading it in the next step) also works naturally.

### SQLite Storage

```sql
CREATE TABLE workflows (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    context         TEXT,                            -- JSON (accumulated step outputs)
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    started_at      TEXT,
    completed_at    TEXT,
    created_by      TEXT NOT NULL DEFAULT 'agent',   -- "agent", "template:name", "trigger:name"
    channel_type    TEXT,                             -- for progress notifications
    channel_chat_id TEXT
);

CREATE TABLE workflow_steps (
    id              TEXT PRIMARY KEY,
    workflow_id     TEXT NOT NULL,
    name            TEXT NOT NULL,
    task_prompt     TEXT NOT NULL,
    agent           TEXT NOT NULL DEFAULT 'build',
    workdir         TEXT,
    depends_on      TEXT,                            -- JSON array of step names
    on_failure      TEXT NOT NULL DEFAULT 'stop',    -- "stop", "continue", or JSON retry config
    status          TEXT NOT NULL DEFAULT 'pending',
    task_id         TEXT,                            -- linked daemon_tasks.id
    output          TEXT,
    error           TEXT,
    started_at      TEXT,
    completed_at    TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE TABLE workflow_templates (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT,
    steps           TEXT NOT NULL,                   -- JSON array of step definitions
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_workflows_status ON workflows(status);
CREATE INDEX idx_workflow_steps_workflow ON workflow_steps(workflow_id);
CREATE INDEX idx_workflow_steps_task ON workflow_steps(task_id);
```

### Agent Tools

Two new tools for the agent:

**`create_workflow`** — Decompose a complex task into tracked steps:
```typescript
{
  name: "create_workflow",
  parameters: {
    name: string,                    // human-readable name
    steps: Array<{
      name: string,                  // unique step identifier
      prompt: string,                // what the step should do
      agent?: string,                // "build" | "plan" (default: "build")
      workdir?: string,              // optional repo/dir override
      depends_on?: string[],         // step names that must complete first
      on_failure?: "stop" | "continue" | { retry: { max_attempts: number } }
    }>,
  }
}
```

**`save_workflow_template`** — Save a reusable workflow pattern:
```typescript
{
  name: "save_workflow_template",
  parameters: {
    name: string,                    // template identifier (e.g., "deploy-api")
    description: string,
    steps: Array<{
      name: string,
      prompt: string,                // can include {{context.variable}} placeholders
      agent?: string,
      workdir?: string,
      depends_on?: string[],
      on_failure?: string
    }>
  }
}
```

### HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workflows` | `GET` | List workflows (filter by status) |
| `/api/workflows` | `POST` | Create and start a workflow |
| `/api/workflows/{id}` | `GET` | Get workflow with all steps and their status |
| `/api/workflows/{id}/cancel` | `POST` | Cancel a running workflow |
| `/api/workflows/{id}/retry` | `POST` | Retry from the first failed step |
| `/api/workflows/templates` | `GET` | List saved templates |
| `/api/workflows/templates` | `POST` | Save a template |
| `/api/workflows/templates/{name}` | `DELETE` | Delete a template |
| `/api/workflows/templates/{name}/run` | `POST` | Instantiate and run a template |

### Channel Integration

New slash commands:
- `/workflow list` — Show running/recent workflows with step progress
- `/workflow status <id>` — Detailed step-by-step status
- `/workflow cancel <id>` — Cancel a running workflow
- `/workflow templates` — List saved templates
- `/workflow run <template> [context]` — Run a saved template

Progress notifications sent automatically to the channel that created the workflow.

### CLI

```bash
kraken workflow list                                    # list running/recent workflows
kraken workflow status <id>                             # step-by-step progress
kraken workflow cancel <id>
kraken workflow retry <id>
kraken workflow templates                               # list saved templates
kraken workflow run <template> --context '{"env":"staging"}'
```

### Trigger Integration

Triggers can reference saved templates:

```jsonc
{
  "triggers": {
    "webhooks": [{
      "name": "deploy-on-push",
      "provider": "github",
      "events": [{
        "type": "push",
        "filter": ["ref equals 'refs/heads/main'"],
        "workflow": "deploy-api",
        "context": {
          "branch": "{{event.ref}}",
          "commit": "{{event.after}}"
        }
      }]
    }]
  }
}
```

## Example: Full Flow

**First time — agent creates workflow dynamically:**
```
User: /task deploy auth to staging and verify

Agent: (decomposes into workflow)
  → create_workflow({ name: "Deploy auth", steps: [...] })

User sees:
  "Workflow 'Deploy auth' started (4 steps)"
  "✓ 1/4 run-tests — 120 tests passed"
  "✓ 2/4 build — image auth:v1.2.3 built"
  "⏳ 3/4 deploy — deploying..."
  "✓ 3/4 deploy — live on staging"
  "✓ 4/4 verify — health check passed"
  "✅ Workflow complete (2m 34s)"
```

**User asks to save it:**
```
User: save that as a template called "deploy-auth"

Agent: save_workflow_template({ name: "deploy-auth", steps: [...] })
  "Template 'deploy-auth' saved. You can run it with /workflow run deploy-auth"
```

**Next time — instant:**
```
User: /workflow run deploy-auth
  → Engine instantiates template, starts execution
```

**Or via trigger — fully automatic:**
```jsonc
"workflow": "deploy-auth"  // in webhook trigger config
```
Push to main → workflow runs automatically → user gets notified on completion.

## Implementation Phases

### Phase 1: Core Infrastructure
- `WorkflowStore` (SQLite tables, CRUD operations)
- `WorkflowEngine` (execution loop, step advancement, completion detection)
- Types (Workflow, WorkflowStep, enums)
- HTTP API (create, get, list, cancel)
- Integration with existing TaskStore (steps create real tasks)

### Phase 2: Agent Tools + Channel Integration
- `create_workflow` tool for the agent
- `save_workflow_template` tool
- `/workflow` slash commands
- Progress notifications to channels
- Template instantiation

### Phase 3: Trigger Integration
- `workflow` field in trigger event config
- Template resolution from trigger context
- Retry from failed step

## Dependencies

- **TaskStore** — steps create tasks via existing infrastructure
- **Orchestrator** — executes the tasks that steps create
- **Channel system** — progress notifications and `/workflow` commands
- **Trigger engine** — workflow field in trigger events
- **Notifications** — workflow-level completion/failure notifications
