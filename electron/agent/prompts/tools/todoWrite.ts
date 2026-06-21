export const TODO_WRITE_NAME = 'TodoWrite'

export const TODO_WRITE_DESCRIPTION = `Create and maintain the current session todo list. Use this for complex multi-step coding work, non-trivial tasks that need planning, user-requested task tracking, or when the user gives multiple tasks.

When to use:
- Use proactively for tasks with 3+ meaningful steps, multiple files, careful planning, or follow-up verification.
- Create or update todos as soon as requirements change.
- Mark exactly one todo as in_progress before starting it, and mark it completed immediately after it is fully done.

When not to use:
- Skip for a single straightforward task, a trivial change, or purely conversational/informational answers.

Rules:
- The input replaces the complete session todo list; include all current todos each time.
- Status must be pending, in_progress, or completed.
- Keep at most one todo in_progress.
- Only mark completed when the work is actually finished. Do not mark completed if tests are failing, implementation is partial, errors remain, or required files/dependencies could not be found.
- Use clear, specific, actionable todo content.
- Remove todos that are no longer relevant from the list rather than keeping stale items.

This schema supports id, content, and status only.`
