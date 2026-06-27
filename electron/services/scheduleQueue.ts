import { randomUUID, randomBytes } from 'crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import { app } from 'electron'
import { Cron } from 'croner'
import type {
  ScheduledTask,
  ScheduledTaskDraft,
  ScheduledTaskPatch,
  ScheduleKind
} from '@shared/scheduleTypes'
import { MIN_EVERY_MS, HARD_TIMEOUT_MS, MAX_CONSECUTIVE_ERRORS, WEBHOOK_TIMEOUT_MS } from '@shared/scheduleTypes'
import { sendToRenderer } from './localWriteRegistry'
import { getQueryEngine, disposeQueryEngine } from '../agent/orchestrator/queryEngine'
import { notifyWeixin } from '../channels/notify'
import { guardOutboundUrl } from '../agent/tools/ssrfGuard'

// 定时任务调度器。照搬 videoTaskQueue.ts 的「内存数组 + 原子持久化 + 单定时器循环 +
// 启动恢复」范式，叠加 croner 的 cron 计算。
// 「绝不卡死」由 executeTask 的四层防御保证，见策划书第五之二章。

// 调度循环延迟上限：防时钟漂移，每次最多睡 60 秒就醒一次重算。
const MAX_TIMER_DELAY_MS = 60 * 1000
// 启动补跑错过周期任务的上限：避免长时间关机后雪崩式补跑。
const MAX_CATCHUP_RUNS = 1

interface QueueFileShape {
  tasks: ScheduledTask[]
}

let tasks: ScheduledTask[] = []
let loaded = false
let timer: ReturnType<typeof setTimeout> | undefined

function queueFile(): string {
  return join(app.getPath('userData'), 'scheduled-tasks.json')
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

function pushUpdate(task: ScheduledTask): void {
  sendToRenderer('schedule:taskUpdate', task)
}

function update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | null {
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx === -1) return null
  const next: ScheduledTask = { ...tasks[idx], ...patch, updatedAt: Date.now() }
  tasks[idx] = next
  persist()
  pushUpdate(next)
  return next
}

// 计算某调度方式从 from 时刻起的下一次执行时间戳；无法计算返回 undefined。
function computeNextRun(schedule: ScheduleKind, from: number): number | undefined {
  if (schedule.kind === 'at') {
    return schedule.at > from ? schedule.at : undefined
  }
  if (schedule.kind === 'every') {
    const interval = Math.max(MIN_EVERY_MS, schedule.everyMs)
    return from + interval
  }
  // cron：用 croner 解析，按时区算下一次。表达式非法时返回 undefined。
  try {
    const c = new Cron(schedule.expr, schedule.tz ? { timezone: schedule.tz } : {})
    const next = c.nextRun(new Date(from))
    c.stop()
    return next ? next.getTime() : undefined
  } catch {
    return undefined
  }
}

// 重算单个任务的 nextRunAt 并落库（不触发执行）。
function recalcNextRun(task: ScheduledTask, from = Date.now()): void {
  if (!task.enabled) {
    if (task.nextRunAt !== undefined) update(task.id, { nextRunAt: undefined })
    return
  }
  const next = computeNextRun(task.schedule, from)
  if (next !== task.nextRunAt) update(task.id, { nextRunAt: next })
}
// 单定时器调度循环：找最近的 nextRunAt，clamp 到 60 秒内，到点收集所有到期任务并发执行。
function armTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  const now = Date.now()
  let earliest = Infinity
  for (const t of tasks) {
    // 排除正在执行的任务：at 任务执行期间 nextRunAt 仍停留在过去，若不排除会与
    // onTimer 的 !running 过滤配合形成 setTimeout(0) 忙转。running 任务跑完后由
    // executeTask 末尾的 armTimer 重新排程，不会漏。
    if (t.enabled && !t.running && t.nextRunAt !== undefined && t.nextRunAt < earliest) {
      earliest = t.nextRunAt
    }
  }
  if (earliest === Infinity) return
  // clamp：即使下次执行还很远，也最多睡 60 秒就醒一次，防时钟漂移。
  const delay = Math.max(0, Math.min(earliest - now, MAX_TIMER_DELAY_MS))
  timer = setTimeout(onTimer, delay)
}

function onTimer(): void {
  timer = undefined
  const now = Date.now()
  const due = tasks.filter(
    (t) => t.enabled && !t.running && t.nextRunAt !== undefined && t.nextRunAt <= now
  )
  for (const task of due) {
    // 派发前先重排下一次（at 任务执行后会被删除，这里算出的 next 对 at 无意义）。
    if (task.schedule.kind !== 'at') {
      recalcNextRun(task, now)
    }
    // fire-and-forget：调度器绝不 await 单个任务，单任务无论发生什么都影响不到循环。
    void executeTask(task.id)
  }
  // 重新武装定时器（含 60 秒 clamp 的下次唤醒）。
  armTimer()
}
// webhook 投递：POST JSON 到任务配置的 URL。SSRF 防护 + 超时，失败返回 false。
async function deliverWebhook(task: ScheduledTask, output: string): Promise<boolean> {
  const url = task.webhookUrl?.trim()
  if (!url) return false
  const guard = await guardOutboundUrl(url)
  if (!guard.ok || !guard.url) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
  try {
    const res = await fetch(guard.url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: task.id,
        name: task.name,
        output,
        ranAt: Date.now()
      }),
      signal: controller.signal
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// 防弹执行：四层防御保证调度器绝不被单任务挂死（见策划书第五之二章）。
async function executeTask(id: string): Promise<void> {
  const task = tasks.find((t) => t.id === id)
  if (!task) return
  if (task.running) {
    update(id, { lastStatus: 'skipped' })
    return
  }
  update(id, { running: true, lastStatus: 'running' })

  const sessionId = `cron:${task.id}`
  const engine = getQueryEngine(sessionId)
  engine.clear(sessionId) // 每次清空，防历史无限累加

  // 无人值守身份说明：定时任务在空白会话里跑，模型不知道自己是「到点触发的任务」，
  // 容易把 prompt 当普通新对话来反问、给选项、要求用户澄清。这里明确告知它：
  // 没人能回答，必须一轮内直接产出最终要交付的内容。
  const wrappedPrompt = [
    '【系统：这是一个无人值守的定时任务，到点自动触发，当前没有真人能与你交互。】',
    '要求：',
    '1. 直接完成下面的任务并输出最终结果，这段结果会被原样推送给用户。',
    '2. 绝不要反问、不要给选项、不要请用户确认或澄清——没有人会回答你。',
    '3. 如果任务只是提醒类（如提醒喝水/提交周报），就直接输出那句提醒本身，不要解释你打算怎么做。',
    '',
    `任务内容：${task.prompt}`
  ].join('\n')

  let timedOut = false
  // 层3：执行循环，主动应答所有已知交互事件，避免 default 模式下永久阻塞。
  const runLoop = (async (): Promise<string> => {
    let output = ''
    for await (const ev of engine.submitTurn({
      sessionId,
      turnId: randomUUID(),
      message: wrappedPrompt,
      permissionMode: task.allowWrite ? 'acceptEdits' : 'default',
      sessionCwd: task.workspaceRoot ?? null
    })) {
      if (ev.type === 'text_delta') output += ev.content
      else if (ev.type === 'permission_request') engine.resolvePermission(ev.requestId, 'deny')
      else if (ev.type === 'file_change_proposed') engine.resolveFileChange(ev.changeId, 'reject')
      else if (ev.type === 'user_question') {
        engine.resolveUserQuestion(ev.requestId, { answer: '', cancelled: true })
      }
      // 未知的未来阻塞事件由层1看门狗 cancel() 兜底结算。
    }
    return output
  })()
  runLoop.catch(() => {}) // 吞掉超时后孤儿 Promise 的迟到 rejection
  // 层1：硬看门狗 —— engine.cancel() 同时 abort 信号 + 结算所有 broker（万能熔断点）。
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    watchdog = setTimeout(() => {
      timedOut = true
      try {
        engine.cancel(sessionId)
      } catch {
        /* 熔断失败也不阻塞结算 */
      }
      resolve(null)
    }, HARD_TIMEOUT_MS)
  })

  let output: string | null = null
  let err: unknown = null
  try {
    // 层2：调度器永不被单任务阻塞——超时分支也会返回。
    output = await Promise.race([runLoop, timeout])
  } catch (e) {
    err = e
  } finally {
    if (watchdog) clearTimeout(watchdog)
  }
  // 结算前重新取任务最新状态：执行的几分钟里用户可能改了投递设置或删除了任务。
  const current = tasks.find((t) => t.id === id)
  if (!current) {
    // 任务执行期间被删除：清理引擎后直接收手，不再投递/写状态。
    try {
      await disposeQueryEngine(sessionId)
    } catch {
      /* 清理失败不影响调度 */
    }
    armTimer()
    return
  }

  // 结算状态（幂等清 running）。
  if (timedOut || err) {
    const n = (current.consecutiveErrors ?? 0) + 1
    const disable = n >= MAX_CONSECUTIVE_ERRORS
    update(id, {
      running: false,
      lastStatus: 'error',
      lastRunAt: Date.now(),
      lastError: timedOut
        ? `执行超时（>${HARD_TIMEOUT_MS / 1000}s）已强制熔断`
        : String(err),
      consecutiveErrors: n,
      ...(disable ? { enabled: false, nextRunAt: undefined } : {})
    })
    if (disable) {
      void notifyWeixin(`⏰ 定时任务「${current.name}」连续失败 ${n} 次，已自动停用。`)
    }
  } else {
    let deliveryStatus: 'delivered' | 'failed' | 'skipped' = 'skipped'
    const text = output ?? ''
    if (current.delivery === 'weixin') {
      deliveryStatus = (await notifyWeixin(text)) ? 'delivered' : 'failed'
    } else if (current.delivery === 'ui') {
      sendToRenderer('schedule:taskOutput', { id, output: text })
      deliveryStatus = 'delivered'
    } else if (current.delivery === 'webhook') {
      deliveryStatus = (await deliverWebhook(current, text)) ? 'delivered' : 'failed'
    }
    update(id, {
      running: false,
      lastStatus: 'ok',
      lastRunAt: Date.now(),
      lastOutput: text.slice(0, 4000),
      lastDeliveryStatus: deliveryStatus,
      consecutiveErrors: 0,
      lastError: undefined
    })
  }

  try {
    await disposeQueryEngine(sessionId) // 必清理，下次重建干净引擎
  } catch {
    /* 清理失败不影响调度 */
  }

  // at 任务执行后删除；删除会重排定时器。其余情况补一次 armTimer，
  // 保证刚跑完（running 期间被 armTimer 跳过）的周期任务按新 nextRunAt 重新排程。
  const after = tasks.find((t) => t.id === id)
  if (after && (after.schedule.kind === 'at' || after.deleteAfterRun)) {
    deleteTask(id)
  } else {
    armTimer()
  }
}
export function listScheduledTasks(): ScheduledTask[] {
  ensureLoaded()
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt)
}

function normalizeSchedule(schedule: ScheduleKind): ScheduleKind {
  if (schedule.kind === 'every') {
    return { kind: 'every', everyMs: Math.max(MIN_EVERY_MS, schedule.everyMs) }
  }
  return schedule
}

export function createScheduledTask(draft: ScheduledTaskDraft): ScheduledTask {
  ensureLoaded()
  const now = Date.now()
  const schedule = normalizeSchedule(draft.schedule)
  const enabled = draft.enabled ?? true
  const task: ScheduledTask = {
    id: `stask-${randomUUID()}`,
    name: draft.name.trim() || '未命名任务',
    description: draft.description,
    enabled,
    deleteAfterRun: draft.deleteAfterRun ?? schedule.kind === 'at',
    schedule,
    prompt: draft.prompt,
    workspaceRoot: draft.workspaceRoot ?? null,
    delivery: draft.delivery ?? 'weixin',
    webhookUrl: draft.webhookUrl,
    allowWrite: draft.allowWrite ?? false,
    createdAt: now,
    updatedAt: now,
    nextRunAt: enabled ? computeNextRun(schedule, now) : undefined,
    consecutiveErrors: 0
  }
  tasks.push(task)
  persist()
  pushUpdate(task)
  armTimer()
  return task
}

export function updateScheduledTask(id: string, patch: ScheduledTaskPatch): ScheduledTask | null {
  ensureLoaded()
  const existing = tasks.find((t) => t.id === id)
  if (!existing) return null
  const merged: Partial<ScheduledTask> = { ...patch }
  if (patch.schedule) merged.schedule = normalizeSchedule(patch.schedule)
  if (patch.name !== undefined) merged.name = patch.name.trim() || '未命名任务'
  // 改了调度方式或重新启用 → 重算下次执行；连续失败计数清零。
  const next = update(id, merged)
  if (!next) return null
  if (patch.schedule || patch.enabled !== undefined) {
    update(id, { consecutiveErrors: 0 })
    recalcNextRun(tasks.find((t) => t.id === id)!)
  }
  armTimer()
  return tasks.find((t) => t.id === id) ?? null
}

export function deleteTask(id: string): void {
  ensureLoaded()
  tasks = tasks.filter((t) => t.id !== id)
  persist()
  sendToRenderer('schedule:taskDeleted', { id })
  armTimer()
}

export function setScheduledTaskEnabled(id: string, enabled: boolean): ScheduledTask | null {
  ensureLoaded()
  const task = tasks.find((t) => t.id === id)
  if (!task) return null
  update(id, {
    enabled,
    consecutiveErrors: 0,
    nextRunAt: enabled ? computeNextRun(task.schedule, Date.now()) : undefined
  })
  armTimer()
  return tasks.find((t) => t.id === id) ?? null
}

// 立即运行：fire-and-forget 派发，不阻塞调用方（IPC）。
export function runScheduledTaskNow(id: string): boolean {
  ensureLoaded()
  const task = tasks.find((t) => t.id === id)
  if (!task) return false
  if (task.running) return false
  void executeTask(id)
  return true
}

// 应用启动时调用：清残留 running、补跑错过的周期任务（带上限）、重算 nextRunAt 后启动循环。
export function resumeSchedulesOnStartup(): void {
  ensureLoaded()
  const now = Date.now()
  for (const task of tasks) {
    // 清掉上次崩溃遗留的 running，否则会被误判为"正在运行"而永久跳过。
    if (task.running) {
      update(task.id, { running: false })
    }
    if (!task.enabled) {
      if (task.nextRunAt !== undefined) update(task.id, { nextRunAt: undefined })
      continue
    }
    // at 任务：已过期未执行的，到点立即补跑一次。
    if (task.schedule.kind === 'at') {
      if (task.schedule.at <= now) {
        void executeTask(task.id)
      } else {
        update(task.id, { nextRunAt: task.schedule.at })
      }
      continue
    }
    // 周期任务：错过的最多补跑 MAX_CATCHUP_RUNS 次，然后重算下次。
    if (task.nextRunAt !== undefined && task.nextRunAt <= now) {
      for (let i = 0; i < MAX_CATCHUP_RUNS; i++) {
        void executeTask(task.id)
      }
    }
    recalcNextRun(task, now)
  }
  armTimer()
}
