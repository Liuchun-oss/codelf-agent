import { z } from 'zod'
import {
  getBackgroundTerminalTask,
  startBackgroundTerminalTask,
  stopBackgroundTerminalTask,
  writeToBackgroundTerminalTask,
  type BackgroundTerminalTask
} from '../../services/backgroundTerminalTasks'
import { resolveAnyPath } from './paths'
import type { Tool, ToolResult } from './types'
import {
  READ_TERMINAL_TASK_DESCRIPTION,
  READ_TERMINAL_TASK_NAME,
  START_TERMINAL_TASK_DESCRIPTION,
  START_TERMINAL_TASK_NAME,
  STOP_TERMINAL_TASK_DESCRIPTION,
  STOP_TERMINAL_TASK_NAME,
  WRITE_TERMINAL_TASK_DESCRIPTION,
  WRITE_TERMINAL_TASK_NAME
} from '../prompts/tools/terminalTasks'

const MAX_OUTPUT_CHARS = 40_000
const MAX_TAIL_LINES = 300

const startTerminalTaskSchema = z.object({
  command: z.string().min(1).describe('Long-running command to start in the background'),
  working_directory: z.string().optional().describe('Optional workspace-relative working directory')
})

type StartTerminalTaskInput = z.infer<typeof startTerminalTaskSchema>

const terminalTaskIdSchema = z.object({
  task_id: z.string().min(1).describe('Background terminal task id')
})

type TerminalTaskIdInput = z.infer<typeof terminalTaskIdSchema>

const writeTerminalTaskSchema = z.object({
  task_id: z.string().min(1).describe('Background terminal task id'),
  input: z.string().describe('Text to write to the task stdin, e.g. "y" to confirm a prompt'),
  append_newline: z
    .boolean()
    .optional()
    .describe('Whether to append a trailing newline (Enter). Defaults to true.')
})

type WriteTerminalTaskInput = z.infer<typeof writeTerminalTaskSchema>

function tailLines(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    const lines = text.split('\n')
    if (lines.length <= MAX_TAIL_LINES) return { text, truncated: false }
    return { text: lines.slice(-MAX_TAIL_LINES).join('\n'), truncated: true }
  }
  const sliced = text.slice(-MAX_OUTPUT_CHARS)
  const lines = sliced.split('\n')
  return { text: lines.slice(-MAX_TAIL_LINES).join('\n'), truncated: true }
}

function formatTask(task: BackgroundTerminalTask): ToolResult {
  const stdout = tailLines(task.stdout)
  const stderr = tailLines(task.stderr)
  const parts: string[] = []
  parts.push(`task id: ${task.id}`)
  parts.push(`status: ${task.status}`)
  parts.push(`cwd: ${task.cwd}`)
  parts.push(`command: ${task.command}`)
  if (task.exitCode !== undefined) parts.push(`exit code: ${task.exitCode ?? 'null'}`)
  if (task.killedBySignal) parts.push(`signal: ${task.killedBySignal}`)
  if (task.error) parts.push(`error: ${task.error}`)
  if (stderr.text.trim()) parts.push(`stderr:\n${stderr.text.trim()}`)
  parts.push(`stdout:\n${stdout.text || '(空)'}`)
  return { content: parts.join('\n'), isError: task.status === 'error', truncated: task.truncated || stdout.truncated || stderr.truncated }
}

export const startTerminalTaskTool: Tool<StartTerminalTaskInput> = {
  name: START_TERMINAL_TASK_NAME,
  description: START_TERMINAL_TASK_DESCRIPTION,
  schema: startTerminalTaskSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.workspaceRoot) return { content: '未打开工作区，无法启动后台终端任务', isError: true }

    let cwd = ctx.workspaceRoot
    try {
      if (input.working_directory) cwd = resolveAnyPath(ctx.workspaceRoot, input.working_directory)
    } catch (e) {
      return { content: e instanceof Error ? e.message : '工作目录无效', isError: true }
    }

    const task = startBackgroundTerminalTask({ cwd, command: input.command })
    return { content: `Started background terminal task ${task.id}\ncommand: ${task.command}\ncwd: ${task.cwd}` }
  }
}

export const readTerminalTaskTool: Tool<TerminalTaskIdInput> = {
  name: READ_TERMINAL_TASK_NAME,
  description: READ_TERMINAL_TASK_DESCRIPTION,
  schema: terminalTaskIdSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    const task = getBackgroundTerminalTask(input.task_id)
    if (!task) return { content: `Background terminal task not found: ${input.task_id}`, isError: true }
    return formatTask(task)
  }
}

export const stopTerminalTaskTool: Tool<TerminalTaskIdInput> = {
  name: STOP_TERMINAL_TASK_NAME,
  description: STOP_TERMINAL_TASK_DESCRIPTION,
  schema: terminalTaskIdSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const task = stopBackgroundTerminalTask(input.task_id)
    if (!task) return { content: `Background terminal task not found: ${input.task_id}`, isError: true }
    return formatTask(task)
  }
}

export const writeTerminalTaskTool: Tool<WriteTerminalTaskInput> = {
  name: WRITE_TERMINAL_TASK_NAME,
  description: WRITE_TERMINAL_TASK_DESCRIPTION,
  schema: writeTerminalTaskSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const appendNewline = input.append_newline !== false
    const data = appendNewline ? `${input.input}\n` : input.input
    const res = writeToBackgroundTerminalTask(input.task_id, data)
    if (!res.ok || !res.task) {
      return { content: res.error ?? 'stdin 写入失败', isError: true }
    }
    const shown = JSON.stringify(input.input)
    return { content: `已向任务 ${input.task_id} 的 stdin 写入 ${shown}${appendNewline ? ' + 换行' : ''}。请用 ReadTerminalTask 查看后续输出。` }
  }
}
