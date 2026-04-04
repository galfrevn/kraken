---
name: memory
description: Persistent memory system -- save and search observations across sessions
---

You have three memory tools: `memory_save`, `memory_search`, and `memory_context`.

## When to save (mandatory)

Call `memory_save` IMMEDIATELY after any of these:
- Bug fix completed
- Architecture or design decision made
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned (name, language, style preferences, etc.)

## How to save

- **title**: Verb + what -- short, searchable (e.g. "Fixed N+1 query in UserList", "Chose Zustand over Redux")
- **type**: Free-form string. Common types: `bugfix`, `decision`, `architecture`, `discovery`, `pattern`, `config`, `learning`, `refactor`, `performance`
- **content**: Structured format:
  ```
  **What**: One sentence -- what was done
  **Why**: What motivated it (user request, bug, performance, etc.)
  **Where**: Files or paths affected
  **Learned**: Gotchas, edge cases, things that surprised you (omit if none)
  ```
- **topic_key** (optional, recommended for evolving topics): Stable key like `architecture/auth-model`. Same key updates the existing memory instead of creating a new one.
- **scope**: `project` (default) for project-specific, `personal` for cross-project knowledge

## User preferences and personal info

When the user tells you their name, language, preferences, or any personal info, save it with `scope: "personal"` and a `user/*` topic key:

```
memory_save({
  type: "preference",
  title: "User name is Alice",
  content: "The user told me their name is Alice.",
  scope: "personal",
  topic_key: "user/name"
})
```

Common user topic keys: `user/name`, `user/language`, `user/style`, `user/preferences`

## Topic key rules

- Different topics must use different keys (e.g. `architecture/auth` vs `bugfix/auth-nil-panic`)
- Reuse the same `topic_key` to update an evolving topic instead of creating duplicates
- Common prefixes: `architecture/*`, `bug/*`, `decision/*`, `pattern/*`, `config/*`, `discovery/*`, `user/*`

## When to search

Call `memory_search` when:
- The user asks to recall something ("remember", "what did we do", "how did we solve")
- Starting work on something that might have been done before
- The user mentions a topic you have no context on -- check if past sessions covered it
- You need the full content of a specific observation: pass `id` instead of `query`

Call `memory_context` when:
- Starting a new session and you want to understand recent project history
- You need a broad overview of what was done recently

## Session close protocol

Before saying "done" or ending a session, save a summary observation:

```
memory_save({
  type: "session-summary",
  title: "Session: [brief description of what was accomplished]",
  content: "## Goal\n[what we were working on]\n\n## Accomplished\n- [completed items]\n\n## Next Steps\n- [what remains]",
  topic_key: "session/[date-or-topic]"
})
```
