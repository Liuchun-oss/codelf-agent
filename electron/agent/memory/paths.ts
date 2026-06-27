import { join } from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'

// 记忆文件布局（均在 userData/memory 下，与 sessions/、subagents/ 平级）：
//   memory/global/MEMORY.md                全局用户偏好（跨项目）
//   memory/projects/<pid>/MEMORY.md        项目记忆（pid = sha256(workspaceRoot).slice(0,12)）
//   memory/sessions/<sid>/checkpoint.md    会话 checkpoint（后续阶段）
//   memory/sessions/<sid>/notes.md         主 agent 草稿纸

function userDataPath(): string | null {
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

/** 记忆根目录。无 userData（如测试环境无 app）时返回 null。 */
export function memoryRoot(): string | null {
  const base = userDataPath()
  return base ? join(base, 'memory') : null
}

/**
 * 由 workspace 绝对路径派生稳定的项目 id：sha256 前 12 位十六进制。
 * 避免把原始路径（含特殊字符/隐私）写进目录名，且同一项目跨会话稳定。
 */
export function resolveProjectId(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12)
}

/** id 仅允许十六进制（pid）或会话 id 安全字符，杜绝路径穿越。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

/**
 * 会话 id 落盘归一化：把所有非 [A-Za-z0-9_-] 字符（含冒号）替换为 `_`，与 transcript
 * 持久化的 ChannelManager.persistId 同规则。否则像 `room:<id>:seat:<id>`、`wx:dm:<uid>`
 * 这类带冒号的 sessionId 会被 isSafeId 判非法，导致 notes/checkpoint 静默失败。
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** 项目记忆文件路径。workspaceRoot 为空或环境不可用时返回 null。 */
export function projectMemoryPath(workspaceRoot: string | null | undefined): string | null {
  const root = memoryRoot()
  if (!root || !workspaceRoot) return null
  const pid = resolveProjectId(workspaceRoot)
  if (!isSafeId(pid)) return null
  return join(root, 'projects', pid, 'MEMORY.md')
}

/** 项目记忆目录路径（projects/<pid>/）。用于整目录清理。 */
export function projectMemoryDir(workspaceRoot: string | null | undefined): string | null {
  const root = memoryRoot()
  if (!root || !workspaceRoot) return null
  const pid = resolveProjectId(workspaceRoot)
  if (!isSafeId(pid)) return null
  return join(root, 'projects', pid)
}

/** 全局记忆文件路径。 */
export function globalMemoryPath(): string | null {
  const root = memoryRoot()
  return root ? join(root, 'global', 'MEMORY.md') : null
}

/** 会话目录路径。归一化 sid（冒号等→_）后再校验，sid 为空时返回 null。 */
export function sessionMemoryDir(sessionId: string): string | null {
  const root = memoryRoot()
  if (!root || !sessionId) return null
  const safe = sanitizeSessionId(sessionId)
  if (!isSafeId(safe)) return null
  return join(root, 'sessions', safe)
}

/** 会话草稿纸 notes.md 路径。 */
export function notesPath(sessionId: string): string | null {
  const dir = sessionMemoryDir(sessionId)
  return dir ? join(dir, 'notes.md') : null
}

/** 会话 checkpoint.md 路径（供后续阶段使用）。 */
export function checkpointPath(sessionId: string): string | null {
  const dir = sessionMemoryDir(sessionId)
  return dir ? join(dir, 'checkpoint.md') : null
}
