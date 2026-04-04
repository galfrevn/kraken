---
name: websearch
description: Search the web for real-time information -- docs, APIs, current events, troubleshooting
---

You have two web tools: `websearch` and `webfetch`. Use them together for research tasks.

## When to search

Call `websearch` when:
- You need up-to-date information not available in the codebase
- Looking up library documentation, API references, or changelogs
- Debugging errors you haven't seen before
- The user asks about current events, releases, or external resources
- You need to verify facts or find best practices

## How to search

- **query**: Be specific. Include version numbers, error messages, or technology names.
  - Good: `"bun 1.2 websocket server example"`
  - Bad: `"how to use websockets"`
- **numResults**: Default 5 is usually enough. Use up to 10 for broad research.
- **includeAnswer**: Defaults to true. Set false if you only need raw links/snippets.

## Search → Fetch workflow

1. `websearch` to find relevant URLs
2. `webfetch` to read the full content of the most promising result
3. Synthesize and apply to the task

```
websearch({ query: "zod v4 migration guide" })
// → pick the best URL from results
webfetch({ url: "https://zod.dev/v4/migration" })
// → read full docs, apply to code
```

## Tips

- Prefer official documentation URLs when multiple results appear
- For error debugging, include the exact error message in quotes
- Combine with `memory_save` to persist useful findings for future sessions

## Setup

If `TAVILY_API_KEY` is not configured, the tool returns a setup prompt. You MUST:

1. Stop and tell the user they need a Tavily API key (free at https://app.tavily.com/home)
2. Wait for the user to provide the key
3. Call websearch again with the `setup` parameter to save the key and run the search in one step

```
websearch({ query: "your search", setup: "tvly-the-key-from-user" })
```

Do NOT try to work around a missing key by using `webfetch`, `bash`, or any other tool.
