// 全屏自主接管控制器（阶段 1：软接管，不锁输入）。
// 由 agent 自主驱动：agent 在正常对话中判断需要操作电脑时调用 EnterDesktopTakeover 进入，
// 用 Desktop* 工具干活，完成后调 ExitDesktopTakeover 退出。本控制器只负责「外壳」：
// 收主窗 / 起覆盖层 / 转发事件到 HUD / 三重退出（ESC、HUD 停止、看门狗）。
// 不自起 agent 循环——执行仍走主 ai:send 流，事件经 feedTakeoverEvent 喂进来。

import { globalShortcut } from 'electron'
import { join } from 'path'
import type {
  TakeoverState,
  TakeoverStatus,
  TakeoverStopReason
} from '@shared/takeoverTypes'
import type { AgentEvent } from '@shared/agentTypes'
import { getQueryEngine } from '../../agent/orchestrator/queryEngine'
import { hideMainWindowToTray, restoreMainWindow } from '../../main/index'
import { createOverlays, destroyOverlays, sendToHud } from './overlayWindows'

// 看门狗：超过该时长无 agent 事件则自动退出接管，杜绝卡死锁不掉。
const WATCHDOG_TIMEOUT_MS = 60_000

let state: TakeoverState = 'idle'
// 当前接管绑定的 agent 会话；ESC/停止/看门狗退出时据此取消该会话。
let activeSessionId: string | null = null
let taskLabel: string | undefined
let watchdogTimer: ReturnType<typeof setTimeout> | null = null
let steps = 0
let exiting = false

function pushStatus(extra?: Partial<TakeoverStatus>): void {
  sendToHud('takeover:status', { state, task: taskLabel, steps, ...extra })
}

function setState(next: TakeoverState, extra?: Partial<TakeoverStatus>): void {
  state = next
  pushStatus(extra)
}

export function getTakeoverState(): TakeoverState {
  return state
}

export function isTakeoverActive(): boolean {
  return state === 'running'
}

export function getTakeoverSessionId(): string | null {
  return activeSessionId
}

function clearWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

function kickWatchdog(): void {
  clearWatchdog()
  watchdogTimer = setTimeout(() => {
    void exitTakeover('watchdog', { cancelAgent: true })
  }, WATCHDOG_TIMEOUT_MS)
}

function registerEscape(): void {
  try {
    globalShortcut.register('Escape', () => {
      void exitTakeover('escape', { cancelAgent: true })
    })
  } catch {
    /* 注册失败不致命，仍有 HUD 停止按钮与看门狗兜底 */
  }
}

function unregisterEscape(): void {
  try {
    globalShortcut.unregister('Escape')
  } catch {
    /* ignore */
  }
}

// 进入接管：收主窗、起覆盖层、注册 ESC、起看门狗。由 EnterDesktopTakeover 工具调用。
export async function enterTakeover(opts: {
  sessionId: string
  task?: string
  displayId?: number
}): Promise<{ ok: boolean; error?: string }> {
  if (state !== 'idle') return { ok: false, error: '接管已在进行中' }
  activeSessionId = opts.sessionId
  taskLabel = opts.task
  steps = 0
  exiting = false

  setState('preparing')
  hideMainWindowToTray()
  // 延迟一拍确保主窗已隐藏，避免覆盖层被遮挡或抢焦点。
  await new Promise((r) => setTimeout(r, 150))
  createOverlays(getPreloadPath(), opts.displayId)

  setState('running')
  registerEscape()
  kickWatchdog()
  return { ok: true }
}

// 退出接管：销毁覆盖层、恢复主窗、注销 ESC。幂等。
// cancelAgent=true 时（ESC/停止/看门狗）顺带取消绑定会话的 agent；
// 由 ExitDesktopTakeover 工具或轮次结束调用时 cancelAgent=false（agent 继续正常回话）。
export async function exitTakeover(
  reason: TakeoverStopReason,
  opts?: { cancelAgent?: boolean }
): Promise<void> {
  if (state === 'idle' || exiting) return
  exiting = true
  const sessionId = activeSessionId

  setState('restoring', { reason })
  clearWatchdog()
  unregisterEscape()

  if (opts?.cancelAgent && sessionId) {
    try {
      getQueryEngine(sessionId).cancel(sessionId)
    } catch {
      /* ignore */
    }
  }

  // 给 HUD 一点时间显示收尾状态，再关覆盖层、恢复主窗。
  await new Promise((r) => setTimeout(r, reason === 'completed' ? 900 : 250))

  destroyOverlays()
  restoreMainWindow()

  activeSessionId = null
  taskLabel = undefined
  steps = 0
  state = 'idle'
  exiting = false
}

// 由主 ai:send 事件循环喂入：把 agent 事件转给 HUD 并刷新看门狗。仅接管激活时生效。
export function feedTakeoverEvent(sessionId: string, ev: AgentEvent): void {
  if (state !== 'running' || sessionId !== activeSessionId) return
  kickWatchdog()
  switch (ev.type) {
    case 'text_delta':
      sendToHud('takeover:event', { kind: 'text', text: ev.content })
      break
    case 'tool_call_start':
      steps += 1
      sendToHud('takeover:event', { kind: 'tool', text: ev.name })
      pushStatus()
      break
    case 'tool_call_progress':
      if (ev.message) sendToHud('takeover:event', { kind: 'tool', text: ev.message })
      break
    case 'error':
      sendToHud('takeover:event', { kind: 'error', text: ev.message })
      break
    default:
      break
  }
}

// 取 preload 路径：覆盖层窗口复用主 preload。
function getPreloadPath(): string {
  return join(__dirname, '../preload/index.js')
}
