import { z } from 'zod'
import type { AgentTask, AgentTaskStatus } from '@shared/agentTypes'
import type { Tool, ToolContext, ToolResult } from './types'
import { createTask, getTask, listTasks, updateTask } from '../tasks/taskStore'
import { APP_NAME } from '@shared/appConfig'

export const TASK_CREATE_NAME = 'TaskCreate'
export const TASK_UPDATE_NAME = 'TaskUpdate'
export const TASK_LIST_NAME = 'TaskList'
export const TASK_GET_NAME = 'TaskGet'

const taskStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

const taskCreateSchema = z.object({
  subject: z.string().min(1).describe('A brief actionable title for the task'),
  description: z.string().describe('What needs to be done'),
  activeForm: z
    .string()
    .min(1)
    .optional()
    .describe('Present continuous form shown while in progress, e.g. "Running tests"')
})

type TaskCreateInput = z.infer<typeof taskCreateSchema>

const taskUpdateSchema = z.object({
  taskId: z.string().min(1).describe('The ID of the task to update'),
  subject: z.string().min(1).optional().describe('New subject for the task'),
  description: z.string().optional().describe('New description for the task'),
  activeForm: z.string().min(1).optional().describe('New present continuous form'),
  status: taskStatusSchema.optional().describe('New task status')
})

type TaskUpdateInput = z.infer<typeof taskUpdateSchema>

const taskGetSchema = z.object({
  taskId: z.string().min(1).describe('The ID of the task to read')
})

type TaskGetInput = z.infer<typeof taskGetSchema>

const emptySchema = z.object({})

type EmptyInput = z.infer<typeof emptySchema>

function sessionId(ctx: ToolContext): string {
  return ctx.sessionId || 'default'
}

function emitTaskListUpdated(ctx: ToolContext, changedTaskId?: string): void {
  if (!ctx.emitEvent || !ctx.turnId) return
  ctx.emitEvent({
    type: 'task_list_updated',
    turnId: ctx.turnId,
    sessionId: sessionId(ctx),
    tasks: listTasks(ctx.sessionId),
    changedTaskId
  })
}

function formatTask(task: AgentTask): string {
  const active = task.activeForm ? ` (${task.activeForm})` : ''
  return `#${task.id} [${task.status}] ${task.subject}${active}`
}

function formatTaskList(tasks: AgentTask[]): string {
  if (tasks.length === 0) return 'No tasks found'
  return tasks.map(formatTask).join('\n')
}

function isAllowedTransition(from: AgentTaskStatus, to: AgentTaskStatus): boolean {
  if (from === to) return true
  if (from === 'pending') return to === 'in_progress'
  if (from === 'in_progress') return to === 'completed'
  return false
}

export const taskCreateTool: Tool<TaskCreateInput> = {
  name: TASK_CREATE_NAME,
  description:
    `Create a new task in the current session task list. Use proactively for complex multi-step work, planning, and user-requested task tracking. Create tasks when a task requires 3 or more distinct steps, careful planning, multiple operations, or when the user provides multiple tasks. Do not use for single trivial tasks or purely informational requests. Fields: subject is a brief actionable title; description explains what needs to be done; activeForm is optional present-continuous text shown while in progress. New tasks are created with status pending. Check TaskList first when needed to avoid duplicates. ${APP_NAME} does not support owner, dependency, metadata, or deleted fields on TaskCreate.`,
  schema: taskCreateSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const task = createTask(ctx.sessionId, input)
    emitTaskListUpdated(ctx, task.id)
    return { content: `Task #${task.id} created successfully: ${task.subject}` }
  }
}

export const taskUpdateTool: Tool<TaskUpdateInput> = {
  name: TASK_UPDATE_NAME,
  description:
    `Update a task in the current session task list. Use TaskGet first when you need the latest full task state before updating. Mark a task in_progress before starting it and completed immediately after fully finishing it. ONLY mark completed when the work is fully accomplished; do not mark completed if tests are failing, implementation is partial, errors remain, or required files/dependencies could not be found. Allowed status workflow is pending -> in_progress -> completed. ${APP_NAME} TaskUpdate only supports taskId, subject, description, activeForm, and status; it does not support deleted status, owner assignment, metadata, blocks, or blockedBy.`,
  schema: taskUpdateSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const { taskId, ...updates } = input
    if (Object.keys(updates).length === 0) {
      return { content: 'No updates provided', isError: true }
    }
    const current = getTask(ctx.sessionId, taskId)
    if (!current) return { content: `Task #${taskId} not found`, isError: true }
    if (updates.status && !isAllowedTransition(current.status, updates.status)) {
      return {
        content: `Invalid status transition for task #${taskId}: ${current.status} -> ${updates.status}. Allowed flow is pending -> in_progress -> completed.`,
        isError: true
      }
    }
    const result = updateTask(ctx.sessionId, taskId, updates)
    if (!result) return { content: `Task #${taskId} not found`, isError: true }
    emitTaskListUpdated(ctx, taskId)
    const changed = result.updatedFields.length > 0 ? result.updatedFields.join(', ') : 'no fields changed'
    const status = result.statusChange ? ` (${result.statusChange.from} -> ${result.statusChange.to})` : ''
    return { content: `Task #${taskId} updated: ${changed}${status}` }
  }
}

export const taskListTool: Tool<EmptyInput> = {
  name: TASK_LIST_NAME,
  description:
    'List all tasks in the current session task list. Use this to see available work, check overall progress, and after completing a task to find the next pending task. Prefer working on tasks in ID order when multiple pending tasks are available, unless dependencies or user instructions require otherwise. Output includes each task id, status, subject, and activeForm when present. Use TaskGet for full details before updating a specific task.',
  schema: emptySchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(_input, ctx): Promise<ToolResult> {
    return { content: formatTaskList(listTasks(ctx.sessionId)) }
  }
}

export const taskGetTool: Tool<TaskGetInput> = {
  name: TASK_GET_NAME,
  description: `Read full details for one task from the current session task list. Use this when you need complete requirements/context before starting work or before updating a task. Output includes subject, description, status, activeForm when present, and timestamps. ${APP_NAME} tasks do not include owner or dependency fields.`,
  schema: taskGetSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    const task = getTask(ctx.sessionId, input.taskId)
    if (!task) return { content: `Task #${input.taskId} not found`, isError: true }
    const details = [
      formatTask(task),
      `Description: ${task.description || '(empty)'}`,
      `Created: ${new Date(task.createdAt).toISOString()}`,
      `Updated: ${new Date(task.updatedAt).toISOString()}`
    ]
    return { content: details.join('\n') }
  }
}

export function isAgentTaskStatus(value: unknown): value is AgentTaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}
