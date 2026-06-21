export const SLEEP_NAME = 'Sleep'

export const SLEEP_DESCRIPTION = `Wait for a specified duration. The user can interrupt the sleep at any time.

Use this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.

Usage:
- "duration_ms" is the duration to wait in milliseconds.
- "reason" optionally explains why the wait is useful.
- You can call this concurrently with other tools — it won't interfere with them.
- Prefer this over running a shell sleep command — it doesn't hold a shell process.
- Do not sleep between commands that can run immediately — just run them.
- For long-running commands, prefer background terminal/task support when available so you can be notified when the command completes. Do not poll unnecessarily.
- Do not retry failing commands in a sleep loop — diagnose the root cause.
- Each wake-up costs an API call, but the prompt cache expires after a period of inactivity — balance accordingly.`
