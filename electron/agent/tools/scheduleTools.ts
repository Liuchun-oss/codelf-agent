import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import type { ScheduledTaskDraft, ScheduleKind, DeliveryMode } from '@shared/scheduleTypes'
import {
  createScheduledTask,
  listScheduledTasks,
  deleteTask,
  setScheduledTaskEnabled
} from '../../services/scheduleQueue'
import {
  SCHEDULE_CREATE_NAME,
  SCHEDULE_LIST_NAME,
  SCHEDULE_DELETE_NAME,
  SCHEDULE_TOGGLE_NAME,
  SCHEDULE_CREATE_DESCRIPTION,
  SCHEDULE_LIST_DESCRIPTION,
  SCHEDULE_DELETE_DESCRIPTION,
  SCHEDULE_TOGGLE_DESCRIPTION
} from '../prompts/tools/schedule'

const scheduleKindSchema = z.union([
  z.object({
    kind: z.literal('at'),
    at: z.number().describe('Absolute time as epoch milliseconds.')
  }),
  z.object({
    kind: z.literal('every'),
    everyMs: z.number().describe('Repeat interval in ms. Minimum 60000 (1 minute).')
  }),
  z.object({
    kind: z.literal('cron'),
    expr: z.string().min(1).describe('Standard 5-field cron expression, e.g. "0 9 * * *".'),
    tz: z.string().optional().describe('IANA timezone, e.g. "Asia/Shanghai".')
  })
])

const createSchema = z.object({
  name: z.string().min(1).describe('Short human-readable task name.'),
  prompt: z.string().min(1).describe('The instruction the agent runs when the task fires.'),
  schedule: scheduleKindSchema,
  workspaceRoot: z
    .string()
    .nullable()
    .optional()
    .describe('Absolute working directory; null/omit for pure chat with no workspace.'),
  delivery: z
    .enum(['none', 'weixin', 'ui', 'webhook'])
    .optional()
    .describe('Where to deliver the result. Defaults to "weixin".'),
  webhookUrl: z
    .string()
    .optional()
    .describe('Target URL when delivery is "webhook" (http/https only).'),
  allowWrite: z
    .boolean()
    .optional()
    .describe('false (default) = read-only. true = auto-approve file/command actions.')
})

type CreateInput = z.infer<typeof createSchema>

const idSchema = z.object({
  id: z.string().min(1).describe('The scheduled task id (stask-...).')
})

type IdInput = z.infer<typeof idSchema>

const toggleSchema = idSchema.extend({
  enabled: z.boolean().describe('true to enable, false to disable.')
})

type ToggleInput = z.infer<typeof toggleSchema>

function describeSchedule(s: ScheduleKind): string {
  if (s.kind === 'at') return `once at ${formatLocal(s.at)}`
  if (s.kind === 'every') return `every ${Math.round(s.everyMs / 60000)} min`
  return `cron "${s.expr}"${s.tz ? ` (${s.tz})` : ''}`
}

// 返回给模型的本地时间（机器时区），已格式化好，模型只需原样引用、不要自己换算。
function formatLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（本地时间）`
}

export const createScheduledTaskTool: Tool<CreateInput> = {
  name: SCHEDULE_CREATE_NAME,
  description: SCHEDULE_CREATE_DESCRIPTION,
  schema: createSchema,
  // 与 TaskCreate 约定一致：改的是应用内部排程状态而非文件系统，可安全自动执行。
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    if (input.delivery === 'webhook' && !/^https?:\/\//i.test(input.webhookUrl ?? '')) {
      return { content: 'delivery 为 webhook 时必须提供合法的 http/https webhookUrl。', isError: true }
    }
    const draft: ScheduledTaskDraft = {
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule as ScheduleKind,
      workspaceRoot: input.workspaceRoot ?? null,
      delivery: (input.delivery as DeliveryMode) ?? 'weixin',
      webhookUrl: input.delivery === 'webhook' ? input.webhookUrl : undefined,
      allowWrite: input.allowWrite ?? false
    }
    const task = createScheduledTask(draft)
    // 非法 cron 表达式 / 已过去的 at 时间会产出 enabled 但 nextRunAt 为空的死任务：
    // 永远不会触发。这里显式报错并清理，避免静默留垃圾。
    if (task.enabled && task.nextRunAt === undefined) {
      deleteTask(task.id)
      const reason =
        task.schedule.kind === 'cron'
          ? `cron 表达式「${task.schedule.expr}」无效或无法算出下次执行时间`
          : task.schedule.kind === 'at'
            ? '指定的执行时间已经是过去时间'
            : '无法算出下次执行时间'
      return { content: `创建失败：${reason}，任务未保留。请修正后重试。`, isError: true }
    }
    const next = task.nextRunAt ? formatLocal(task.nextRunAt) : '(disabled)'
    return {
      content:
        `已创建定时任务「${task.name}」(id: ${task.id})\n` +
        `调度：${describeSchedule(task.schedule)}\n` +
        `下次执行：${next}\n` +
        `投递：${task.delivery}${task.allowWrite ? '\n⚠️ 该任务允许写入/执行命令' : '（只读）'}\n\n` +
        `[重要] 上面的「下次执行」就是权威的准确时间，请向用户复述时原样照搬这个时间字符串，不要自己重新计算或换算时区，否则会算错。`
    }
  }
}

export const listScheduledTasksTool: Tool<Record<string, never>> = {
  name: SCHEDULE_LIST_NAME,
  description: SCHEDULE_LIST_DESCRIPTION,
  schema: z.object({}),
  readOnly: true,
  concurrencySafe: true,
  async execute(): Promise<ToolResult> {
    const tasks = listScheduledTasks()
    if (tasks.length === 0) return { content: '当前没有定时任务。' }
    const lines = tasks.map((t) => {
      const next = t.enabled ? (t.nextRunAt ? formatLocal(t.nextRunAt) : '—') : 'disabled'
      const status = t.lastStatus ? ` last=${t.lastStatus}` : ''
      return `- ${t.id} | ${t.name} | ${describeSchedule(t.schedule)} | ${t.enabled ? 'enabled' : 'disabled'} | next=${next}${status}`
    })
    return {
      content:
        lines.join('\n') +
        '\n\n[重要] 上面的 next 即权威准确时间，复述给用户时原样照搬，不要自己换算时区。'
    }
  }
}

export const deleteScheduledTaskTool: Tool<IdInput> = {
  name: SCHEDULE_DELETE_NAME,
  description: SCHEDULE_DELETE_DESCRIPTION,
  schema: idSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const exists = listScheduledTasks().some((t) => t.id === input.id)
    if (!exists) return { content: `未找到定时任务 ${input.id}。`, isError: true }
    deleteTask(input.id)
    return { content: `已删除定时任务 ${input.id}。` }
  }
}

export const toggleScheduledTaskTool: Tool<ToggleInput> = {
  name: SCHEDULE_TOGGLE_NAME,
  description: SCHEDULE_TOGGLE_DESCRIPTION,
  schema: toggleSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const task = setScheduledTaskEnabled(input.id, input.enabled)
    if (!task) return { content: `未找到定时任务 ${input.id}。`, isError: true }
    return { content: `定时任务「${task.name}」已${input.enabled ? '启用' : '停用'}。` }
  }
}
