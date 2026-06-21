import type { AgentTask, AgentTaskStatus } from '@shared/agentTypes'

export type CreateTaskInput = {
  subject: string
  description: string
  activeForm?: string
}

export type UpdateTaskInput = {
  subject?: string
  description?: string
  activeForm?: string
  status?: AgentTaskStatus
}

const tasksBySession = new Map<string, AgentTask[]>()
const highWaterMarks = new Map<string, number>()

function normalizeSessionId(sessionId?: string): string {
  return sessionId && sessionId.trim() ? sessionId : 'default'
}

function cloneTask(task: AgentTask): AgentTask {
  return { ...task }
}

function cloneTasks(tasks: AgentTask[]): AgentTask[] {
  return tasks.map(cloneTask)
}

function getMutableTasks(sessionId?: string): AgentTask[] {
  const id = normalizeSessionId(sessionId)
  const existing = tasksBySession.get(id)
  if (existing) return existing
  const fresh: AgentTask[] = []
  tasksBySession.set(id, fresh)
  highWaterMarks.set(id, 0)
  return fresh
}

function nextTaskId(sessionId: string): string {
  const current = highWaterMarks.get(sessionId) ?? 0
  const next = current + 1
  highWaterMarks.set(sessionId, next)
  return String(next)
}

function syncHighWaterMark(sessionId: string, tasks: AgentTask[]): void {
  let max = highWaterMarks.get(sessionId) ?? 0
  for (const task of tasks) {
    const n = Number.parseInt(task.id, 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  highWaterMarks.set(sessionId, max)
}

export function createTask(sessionId: string | undefined, input: CreateTaskInput): AgentTask {
  const id = normalizeSessionId(sessionId)
  const tasks = getMutableTasks(id)
  const now = Date.now()
  const task: AgentTask = {
    id: nextTaskId(id),
    subject: input.subject,
    description: input.description,
    activeForm: input.activeForm,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  }
  tasks.push(task)
  return cloneTask(task)
}

export function getTask(sessionId: string | undefined, taskId: string): AgentTask | null {
  const tasks = getMutableTasks(sessionId)
  const task = tasks.find((t) => t.id === taskId)
  return task ? cloneTask(task) : null
}

export function listTasks(sessionId?: string): AgentTask[] {
  return cloneTasks(getMutableTasks(sessionId)).sort((a, b) => {
    const an = Number.parseInt(a.id, 10)
    const bn = Number.parseInt(b.id, 10)
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
    return a.id.localeCompare(b.id)
  })
}

export function updateTask(
  sessionId: string | undefined,
  taskId: string,
  input: UpdateTaskInput
): { task: AgentTask; updatedFields: string[]; statusChange?: { from: AgentTaskStatus; to: AgentTaskStatus } } | null {
  const tasks = getMutableTasks(sessionId)
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return null

  const updatedFields: string[] = []
  let statusChange: { from: AgentTaskStatus; to: AgentTaskStatus } | undefined

  if (input.subject !== undefined && input.subject !== task.subject) {
    task.subject = input.subject
    updatedFields.push('subject')
  }
  if (input.description !== undefined && input.description !== task.description) {
    task.description = input.description
    updatedFields.push('description')
  }
  if (input.activeForm !== undefined && input.activeForm !== task.activeForm) {
    task.activeForm = input.activeForm
    updatedFields.push('activeForm')
  }
  if (input.status !== undefined && input.status !== task.status) {
    statusChange = { from: task.status, to: input.status }
    task.status = input.status
    updatedFields.push('status')
  }

  if (updatedFields.length > 0) task.updatedAt = Date.now()

  return { task: cloneTask(task), updatedFields, statusChange }
}

export function replaceTasks(sessionId: string | undefined, tasks: readonly AgentTask[]): AgentTask[] {
  const id = normalizeSessionId(sessionId)
  const sanitized = tasks.map((task) => ({ ...task }))
  tasksBySession.set(id, sanitized)
  syncHighWaterMark(id, sanitized)
  return cloneTasks(sanitized)
}

export function resetTasks(sessionId?: string): void {
  const id = normalizeSessionId(sessionId)
  tasksBySession.delete(id)
  highWaterMarks.delete(id)
}
