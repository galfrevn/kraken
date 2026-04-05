# SDK

A TypeScript client library for programmatic interaction with the Kraken daemon.

---

## Usage

```typescript
import { DaemonClient } from "@kraken/sdk";

const client = new DaemonClient({ baseUrl: "http://localhost:50051" });
```

---

## Tasks

```typescript
// Schedule a task
const task = await client.schedule({
  prompt: "Run tests and fix failures",
  priority: 5,
  agent: "build",
});

// List tasks
const tasks = await client.tasks.list({ status: "running" });

// Get task details
const details = await client.tasks.get(taskId);

// Cancel a task
await client.tasks.cancel(taskId);

// Delete a task
await client.tasks.delete(taskId);
```

---

## Memory

```typescript
// Search persistent memory
const results = await client.memorySearch({ query: "api keys" });
```

---

## Events

```typescript
// Stream real-time events
client.onEvent("task_completed", (event) => {
  console.log(event);
});
```

---

## Source

See [`packages/sdk/`](../../packages/sdk/) for the full implementation.
