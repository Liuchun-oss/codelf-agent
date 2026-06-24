import { randomUUID, randomBytes } from 'crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import { app } from 'electron'
import type { VideoTask } from '@shared/agentSettings'
import { sendToRenderer } from './localWriteRegistry'
import {
  submitVideoTask,
  pollVideoTaskOnce,
  downloadAndSaveVideo,
  type VideoGenRequest
} from '../agent/services/videoGenService'

// 视频生成是慢异步任务。这里维护一个持久化任务队列，提交后在后台并发轮询，
// 状态变化通过 IPC 推给渲染进程的「视频队列」面板，不阻塞主对话。

const POLL_INTERVAL_MS = 5000
// 单个任务从开始轮询起的最大存活时间，避免卡死任务永久占用轮询。
const MAX_TASK_LIFETIME_MS = 20 * 60 * 1000

interface QueueFileShape {
  tasks: VideoTask[]
}

let tasks: VideoTask[] = []
let loaded = false
// 正在轮询的本地任务 id → 定时器。
const pollers = new Map<string, ReturnType<typeof setInterval>>()
const pollStartedAt = new Map<string, number>()

function queueFile(): string {
  return join(app.getPath('userData'), 'video-tasks.json')
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const f = queueFile()
    if (existsSync(f)) {
      const parsed = JSON.parse(readFileSync(f, 'utf-8')) as QueueFileShape
      tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : []
    }
  } catch {
    tasks = []
  }
}

function persist(): void {
  try {
    const target = queueFile()
    mkdirSync(dirname(target), { recursive: true })
    const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
    writeFileSync(tmp, JSON.stringify({ tasks } satisfies QueueFileShape, null, 2), 'utf-8')
    renameSync(tmp, target)
  } catch {
    /* 持久化失败不致命，下次再写 */
  }
}

function pushUpdate(task: VideoTask): void {
  sendToRenderer('video:taskUpdate', task)
}

function update(id: string, patch: Partial<VideoTask>): VideoTask | null {
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx === -1) return null
  const next: VideoTask = { ...tasks[idx], ...patch, updatedAt: Date.now() }
  tasks[idx] = next
  persist()
  pushUpdate(next)
  return next
}

function stopPolling(id: string): void {
  const timer = pollers.get(id)
  if (timer) clearInterval(timer)
  pollers.delete(id)
  pollStartedAt.delete(id)
}

function beginPolling(id: string): void {
  if (pollers.has(id)) return
  pollStartedAt.set(id, Date.now())
  const timer = setInterval(() => {
    void pollOnce(id)
  }, POLL_INTERVAL_MS)
  pollers.set(id, timer)
}

async function pollOnce(id: string): Promise<void> {
  const task = tasks.find((t) => t.id === id)
  if (!task || !task.remoteTaskId) {
    stopPolling(id)
    return
  }
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
    stopPolling(id)
    return
  }
  const startedAt = pollStartedAt.get(id) ?? Date.now()
  if (Date.now() - startedAt > MAX_TASK_LIFETIME_MS) {
    stopPolling(id)
    update(id, { status: 'failed', error: '视频生成超时（后台轮询超过最大时长）。' })
    return
  }

  const res = await pollVideoTaskOnce(task.remoteTaskId)
  // 轮询过程中任务可能被取消。
  const current = tasks.find((t) => t.id === id)
  if (!current || current.status === 'cancelled') {
    stopPolling(id)
    return
  }

  if (res.state === 'running') {
    const secs = Math.round((Date.now() - startedAt) / 1000)
    update(id, { status: 'running', progress: `${res.statusText ?? '生成中…'}已用时 ${secs}s` })
    return
  }
  if (res.state === 'failed') {
    stopPolling(id)
    update(id, { status: 'failed', error: res.error ?? '视频生成失败', progress: undefined })
    return
  }
  // succeeded：下载转存。
  update(id, { progress: '生成完成，正在下载…' })
  // outputPath 在入队时已解析为绝对路径，这里无需再依赖 workspaceRoot。
  const saved = await downloadAndSaveVideo(res.videoUrl ?? '', {
    outputPath: current.outputPath,
    workspaceRoot: null
  })
  stopPolling(id)
  if (!saved) {
    update(id, { status: 'failed', error: '视频已生成但本地保存失败。', progress: undefined })
    return
  }
  update(id, { status: 'succeeded', videoUrl: saved.url, filePath: saved.filePath, progress: undefined })
}

export interface EnqueueParams {
  prompt: string
  req: VideoGenRequest
  resolution: string
  ratio: string
  duration: number
  generateAudio: boolean
  // agent 指定的输出位置（已解析为绝对路径，目录或完整文件路径）。
  outputPath?: string
}

// 入队一个视频任务：先创建本地记录（queued），异步提交火山，成功后开始轮询。
export function enqueueVideoTask(params: EnqueueParams): VideoTask {
  ensureLoaded()
  const now = Date.now()
  const task: VideoTask = {
    id: `vtask-${randomUUID()}`,
    status: 'queued',
    prompt: params.prompt,
    resolution: params.resolution,
    ratio: params.ratio,
    duration: params.duration,
    generateAudio: params.generateAudio,
    outputPath: params.outputPath,
    createdAt: now,
    updatedAt: now
  }
  tasks.push(task)
  persist()
  pushUpdate(task)

  void (async () => {
    const submitted = await submitVideoTask(params.req)
    const current = tasks.find((t) => t.id === task.id)
    if (!current || current.status === 'cancelled') return
    if (!submitted.ok || !submitted.remoteTaskId) {
      update(task.id, { status: 'failed', error: submitted.error ?? '提交任务失败' })
      return
    }
    update(task.id, { status: 'running', remoteTaskId: submitted.remoteTaskId, progress: '任务已提交，生成中…' })
    beginPolling(task.id)
  })()

  return task
}

export function listVideoTasks(): VideoTask[] {
  ensureLoaded()
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt)
}

export function getVideoTask(id: string): VideoTask | null {
  ensureLoaded()
  return tasks.find((t) => t.id === id) ?? null
}

export function cancelVideoTask(id: string): VideoTask | null {
  ensureLoaded()
  stopPolling(id)
  const task = tasks.find((t) => t.id === id)
  if (!task) return null
  if (task.status === 'succeeded' || task.status === 'failed') return task
  return update(id, { status: 'cancelled', progress: undefined })
}

export function deleteVideoTask(id: string): void {
  ensureLoaded()
  stopPolling(id)
  tasks = tasks.filter((t) => t.id !== id)
  persist()
  sendToRenderer('video:taskDeleted', { id })
}

export function clearFinishedVideoTasks(): void {
  ensureLoaded()
  for (const t of tasks) {
    if (t.status === 'running' || t.status === 'queued') stopPolling(t.id)
  }
  tasks = tasks.filter((t) => t.status === 'running' || t.status === 'queued')
  persist()
  sendToRenderer('video:taskCleared', {})
}

// 应用启动时调用：把上次未完成（running 且有 remoteTaskId）的任务恢复轮询；
// 没有 remoteTaskId 的 queued 任务无法恢复，标记为失败。
export function resumeVideoTasksOnStartup(): void {
  ensureLoaded()
  for (const task of tasks) {
    if (task.status === 'running' && task.remoteTaskId) {
      beginPolling(task.id)
    } else if (task.status === 'queued' || (task.status === 'running' && !task.remoteTaskId)) {
      update(task.id, { status: 'failed', error: '应用重启，任务状态丢失，请重新提交。' })
    }
  }
}
