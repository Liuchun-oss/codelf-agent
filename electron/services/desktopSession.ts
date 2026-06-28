import { randomUUID } from 'crypto'

// 桌面控制会话：缓存目标窗口句柄，按 agentSessionId 生命周期清理。
// 与 browserSession 同构，但不持有长生进程——窗口由外部程序拥有，
// 我们只缓存定位信息（平台原生句柄/winId、标题、进程）。

export type DesktopSessionStatus = 'open' | 'closed'

export interface DesktopWindowRef {
  // 会话内稳定的窗口标识，供后续工具引用。
  windowId: string
  // 平台原生句柄：Windows 为 HWND（十进制字符串），macOS 为 "pid:windowId" 或进程名。
  nativeHandle: string
  title: string
  processName: string
  processId: number
  createdAt: number
  // 最近一次截图的缩放系数（imageWidth / clientWidth）。用于把模型在缩放截图上
  // 读到的「图片像素坐标」换算回「客户区像素坐标」。未截图时为 undefined。
  lastScreenshotScale?: number
}

export interface DesktopSession {
  id: string
  status: DesktopSessionStatus
  agentSessionId?: string
  windows: Map<string, DesktopWindowRef>
  // 由本会话启动的进程 pid，用于关闭与清理。
  launchedPids: Set<number>
  createdAt: number
  updatedAt: number
}

const sessions = new Map<string, DesktopSession>()

function touch(session: DesktopSession): void {
  session.updatedAt = Date.now()
}

export function openDesktopSession(agentSessionId?: string): DesktopSession {
  const now = Date.now()
  const session: DesktopSession = {
    id: `desktop-${randomUUID()}`,
    status: 'open',
    agentSessionId,
    windows: new Map(),
    launchedPids: new Set(),
    createdAt: now,
    updatedAt: now
  }
  sessions.set(session.id, session)
  return session
}

// 取已有会话；无则为该 agent 新建一个，保证工具间共享窗口缓存。
export function ensureDesktopSession(agentSessionId?: string): DesktopSession {
  if (agentSessionId) {
    for (const s of sessions.values()) {
      if (s.status === 'open' && s.agentSessionId === agentSessionId) return s
    }
  }
  return openDesktopSession(agentSessionId)
}

export function getDesktopSession(id: string): DesktopSession | undefined {
  return sessions.get(id)
}

export function registerWindow(
  sessionId: string,
  ref: Omit<DesktopWindowRef, 'windowId' | 'createdAt'>
): DesktopWindowRef | undefined {
  const session = sessions.get(sessionId)
  if (!session || session.status !== 'open') return undefined
  // 同一原生句柄复用既有 windowId，避免重复登记。
  for (const existing of session.windows.values()) {
    if (existing.nativeHandle === ref.nativeHandle) {
      existing.title = ref.title
      existing.processName = ref.processName
      existing.processId = ref.processId
      touch(session)
      return existing
    }
  }
  const windowId = `win-${randomUUID().slice(0, 8)}`
  const full: DesktopWindowRef = { ...ref, windowId, createdAt: Date.now() }
  session.windows.set(windowId, full)
  touch(session)
  return full
}

export function getWindow(sessionId: string, windowId: string): DesktopWindowRef | undefined {
  return sessions.get(sessionId)?.windows.get(windowId)
}

// 记录某窗口最近一次截图的缩放系数，供坐标工具把图片坐标换算回客户区坐标。
export function setWindowScreenshotScale(sessionId: string, windowId: string, scale: number): void {
  const win = sessions.get(sessionId)?.windows.get(windowId)
  if (win && Number.isFinite(scale) && scale > 0) win.lastScreenshotScale = scale
}

export function trackLaunchedPid(sessionId: string, pid: number): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.launchedPids.add(pid)
  touch(session)
}

export function closeDesktopSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  session.status = 'closed'
  session.windows.clear()
  sessions.delete(id)
  return true
}

export function closeDesktopSessionsForAgent(agentSessionId: string): void {
  for (const [id, s] of [...sessions.entries()]) {
    if (s.agentSessionId === agentSessionId) closeDesktopSession(id)
  }
}

export function resetDesktopSessions(): void {
  sessions.clear()
}
