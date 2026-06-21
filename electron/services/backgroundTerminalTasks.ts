import { randomUUID } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { killProcessTree, shellInvocation } from './headlessTerminal'

export type BackgroundTerminalStatus = 'running' | 'completed' | 'error' | 'stopped'

export interface BackgroundTerminalTask {
  id: string
  command: string
  cwd: string
  status: BackgroundTerminalStatus
  startedAt: number
  updatedAt: number
  exitCode?: number | null
  killedBySignal?: string
  stdout: string
  stderr: string
  truncated: boolean
  error?: string
}

export interface StartBackgroundTerminalOptions {
  cwd: string
  command: string
  env?: Record<string, string>
  maxOutputChars?: number
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024
const tasks = new Map<string, BackgroundTerminalTask>()
const processes = new Map<string, ChildProcess>()

function appendCapped(task: BackgroundTerminalTask, key: 'stdout' | 'stderr', chunk: Buffer, cap: number): void {
  if (task[key].length >= cap) {
    task.truncated = true
    task.updatedAt = Date.now()
    return
  }
  const next = task[key] + chunk.toString('utf8')
  if (next.length > cap) {
    task[key] = next.slice(-cap)
    task.truncated = true
  } else {
    task[key] = next
  }
  task.updatedAt = Date.now()
}

function cloneTask(task: BackgroundTerminalTask): BackgroundTerminalTask {
  return { ...task }
}

export function startBackgroundTerminalTask(options: StartBackgroundTerminalOptions): BackgroundTerminalTask {
  const id = `term-${randomUUID()}`
  const now = Date.now()
  const task: BackgroundTerminalTask = {
    id,
    command: options.command,
    cwd: options.cwd,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    stdout: '',
    stderr: '',
    truncated: false
  }
  tasks.set(id, task)

  const { file, args } = shellInvocation(options.command)
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  processes.set(id, child)
  const cap = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT

  child.stdout?.on('data', (chunk: Buffer) => appendCapped(task, 'stdout', chunk, cap))
  child.stderr?.on('data', (chunk: Buffer) => appendCapped(task, 'stderr', chunk, cap))
  child.on('error', (err) => {
    task.status = 'error'
    task.error = err instanceof Error ? err.message : String(err)
    task.updatedAt = Date.now()
    processes.delete(id)
  })
  child.on('close', (code, signal) => {
    if (task.status === 'running') task.status = 'completed'
    task.exitCode = code
    task.killedBySignal = signal ?? undefined
    task.updatedAt = Date.now()
    processes.delete(id)
  })

  return cloneTask(task)
}

export function getBackgroundTerminalTask(id: string): BackgroundTerminalTask | undefined {
  const task = tasks.get(id)
  return task ? cloneTask(task) : undefined
}

export function stopBackgroundTerminalTask(id: string): BackgroundTerminalTask | undefined {
  const task = tasks.get(id)
  if (!task) return undefined
  const child = processes.get(id)
  if (child && task.status === 'running') {
    task.status = 'stopped'
    task.updatedAt = Date.now()
    killProcessTree(child)
  }
  return cloneTask(task)
}

export interface WriteTerminalTaskResult {
  ok: boolean
  task?: BackgroundTerminalTask
  error?: string
}

/**
 * 向运行中的后台终端任务写入 stdin（用于应答 y/n、回车等交互提示）。
 * data 原样写入；调用方需自行决定是否追加换行。
 */
export function writeToBackgroundTerminalTask(id: string, data: string): WriteTerminalTaskResult {
  const task = tasks.get(id)
  if (!task) return { ok: false, error: `Background terminal task not found: ${id}` }
  if (task.status !== 'running') {
    return { ok: false, error: `Task ${id} is not running (status: ${task.status})`, task: cloneTask(task) }
  }
  const child = processes.get(id)
  if (!child || !child.stdin || child.stdin.destroyed) {
    return { ok: false, error: `Task ${id} stdin is not writable`, task: cloneTask(task) }
  }
  try {
    child.stdin.write(data)
    task.updatedAt = Date.now()
    return { ok: true, task: cloneTask(task) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'stdin 写入失败', task: cloneTask(task) }
  }
}

export function resetBackgroundTerminalTasks(): void {  for (const child of processes.values()) killProcessTree(child)
  processes.clear()
  tasks.clear()
}
