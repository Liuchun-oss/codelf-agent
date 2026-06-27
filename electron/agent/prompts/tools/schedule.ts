export const SCHEDULE_CREATE_NAME = 'CreateScheduledTask'
export const SCHEDULE_LIST_NAME = 'ListScheduledTasks'
export const SCHEDULE_DELETE_NAME = 'DeleteScheduledTask'
export const SCHEDULE_TOGGLE_NAME = 'ToggleScheduledTask'

export const SCHEDULE_CREATE_DESCRIPTION = `Create a scheduled task that automatically wakes the agent at a future time / on a recurring schedule to run a prompt unattended, then delivers the result (e.g. push to WeChat / 微信).

Use this when the user asks to be reminded, to run something on a schedule, or "每天/每隔.../定时/到点 帮我做某事" — e.g. "每天早上9点汇总昨天的git改动发微信", "每30分钟检查一次服务状态", "今晚8点提醒我提交周报".

Scheduling is one of three kinds (provide exactly one shape in "schedule"):
- { "kind": "at", "at": <epoch_ms> } run once at an absolute time, then auto-delete.
- { "kind": "every", "everyMs": <number> } repeat on a fixed interval (minimum 60000 ms = 1 minute).
- { "kind": "cron", "expr": "<5-field cron>", "tz": "Asia/Shanghai" } standard cron with optional timezone, e.g. "0 9 * * *" = every day 09:00.

Other parameters:
- "name": short human-readable task name.
- "prompt": the instruction the agent will run when it fires.
- "workspaceRoot" (optional): absolute directory the task runs in; omit / null for a pure chat with no workspace.
- "delivery" (optional): "weixin" (push result to the WeChat owner, default), "ui", "webhook", or "none".
- "webhookUrl" (optional): required when delivery is "webhook"; http/https only.
- "allowWrite" (optional, default false): false = read-only, the task auto-denies all file/command actions. true = auto-approves file/command actions (dangerous/system paths are still hard-blocked). Only set true if the user clearly wants the task to modify files or run commands.

Returns the created task id. The task persists across app restarts.`

export const SCHEDULE_LIST_DESCRIPTION = `List all scheduled tasks with their id, name, schedule, enabled state, next run time and last run status. Use this to show the user their scheduled tasks, or to find a task id before deleting / toggling it.`

export const SCHEDULE_DELETE_DESCRIPTION = `Delete a scheduled task by id. Use ListScheduledTasks first to find the id. This is permanent.`

export const SCHEDULE_TOGGLE_DESCRIPTION = `Enable or disable a scheduled task by id without deleting it. Disabled tasks keep their config but never fire. Use ListScheduledTasks first to find the id.`
