---
name: heartbeat
description: Proactive autonomous agent heartbeat — reads HEARTBEAT.md and executes applicable tasks based on current time
trigger: cron
---

# Heartbeat Skill

You have been invoked by a scheduled heartbeat trigger. Your job is to check the user's `HEARTBEAT.md` file and execute any tasks that are currently applicable.

## Instructions

1. **Read `~/.kraken/HEARTBEAT.md`**
   - If the file does not exist, report that no heartbeat tasks are configured and exit cleanly.

2. **Check quiet hours**
   - The file may contain a `## Quiet Hours` section with time ranges (e.g., `22:00-07:00`).
   - Determine the current local time. If the current time falls within a quiet-hours window, skip all tasks and exit with a brief note.

3. **Parse task entries**
   - Tasks are listed under `## Tasks` as markdown list items.
   - Each task has a description and an optional time-window annotation in parentheses, e.g.:
     ```
     - Check for new GitHub notifications (every hour, 09:00-18:00)
     - Summarize today's completed tasks (daily, after 17:00)
     - Review open PRs older than 3 days (weekly, Monday morning)
     ```

4. **Evaluate applicability**
   - For each task, determine if the current time matches the described frequency/window.
   - Use common sense: "every hour" means run each invocation during the window; "daily after 17:00" means run once if it's past 17:00; "weekly Monday morning" means run if it's Monday before noon.
   - If a task has no time annotation, treat it as applicable on every invocation.

5. **Execute applicable tasks**
   - For each applicable task, carry out the described action using available tools.
   - Be concise in your output — this runs unattended.

6. **Report results**
   - Provide a brief summary of which tasks were executed and their outcomes.
   - If no tasks were applicable, state that explicitly.

## Example HEARTBEAT.md

```markdown
## Quiet Hours
22:00-07:00

## Tasks
- Check for new GitHub notifications and summarize unread ones (every hour, 09:00-18:00)
- Summarize today's completed daemon tasks (daily, after 17:00)
- Review open PRs older than 3 days and post a reminder (weekly, Monday 09:00-12:00)
- Clean up temporary files in ~/Downloads older than 7 days (daily, 02:00-05:00)
```
