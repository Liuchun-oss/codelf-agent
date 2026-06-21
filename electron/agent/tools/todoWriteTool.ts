import { z } from 'zod'
import type { AgentTask, AgentTaskStatus } from '@shared/agentTypes'
import type { Tool, ToolContext, ToolResult } from './types'
import { replaceTasks } from '../tasks/taskStore'
import { TODO_WRITE_DESCRIPTION, TODO_WRITE_NAME } from '../prompts/tools/todoWrite'

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

const todoSchema = z.object({
  id: z.string().min(1).describe('Stable todo id'),
  content: z.string().min(1).describe('The todo description'),
  status: todoStatusSchema.describe('Current todo status')
})

const todoWriteSchema = z.object({
  todos: z.array(todoSchema).min(1).max(100).describe('The complete todo list to store for this session')
})

type TodoWriteInput = z.infer<typeof todoWriteSchema>

function sessionId(ctx: ToolContext): string {
  return ctx.sessionId || 'default'
}

function statusSummary(tasks: AgentTask[]): string {
  const counts: Record<AgentTaskStatus, number> = { pending: 0, in_progress: 0, completed: 0 }
  for (const task of tasks) counts[task.status]++
  return `pending=${counts.pending}, in_progress=${counts.in_progress}, completed=${counts.completed}`
}

function emitTaskListUpdated(ctx: ToolContext, tasks: AgentTask[]): void {
  if (!ctx.emitEvent || !ctx.turnId) return
  ctx.emitEvent({
    type: 'task_list_updated',
    turnId: ctx.turnId,
    sessionId: sessionId(ctx),
    tasks
  })
}

export const todoWriteTool: Tool<TodoWriteInput> = {
  name: TODO_WRITE_NAME,
  description: TODO_WRITE_DESCRIPTION,
  schema: todoWriteSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const inProgress = input.todos.filter((todo) => todo.status === 'in_progress')
    if (inProgress.length > 1) {
      return { content: 'TodoWrite requires at most one in_progress todo.', isError: true }
    }

    const now = Date.now()
    const tasks: AgentTask[] = input.todos.map((todo) => ({
      id: todo.id,
      subject: todo.content,
      description: todo.content,
      status: todo.status,
      activeForm: todo.status === 'in_progress' ? todo.content : undefined,
      createdAt: now,
      updatedAt: now
    }))

    const stored = replaceTasks(ctx.sessionId, tasks)
    emitTaskListUpdated(ctx, stored)
    return { content: `Todo list updated with ${stored.length} item(s): ${statusSummary(stored)}` }
  }
}
