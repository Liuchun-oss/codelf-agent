// C9：进行中轮次的持久化标记。
// QueryEngine 的 broker（权限/提问/文件改动）都在内存，Codelf 退出/崩溃后，
// 任何"未回复的确认"或"进行中的轮次"都会失效。重启后无法续上。
// 这里把"正在进行的会话"落盘；重启时若发现残留，提示机主"上一个操作已中断"。

import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

interface PendingShape {
  // 进行中的会话 id 列表。
  active: string[]
}

function pendingFile(): string {
  return join(app.getPath('userData'), 'weixin-pending.json')
}

function read(): Set<string> {
  const file = pendingFile()
  if (!existsSync(file)) return new Set()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as PendingShape
    return new Set(Array.isArray(parsed?.active) ? parsed.active : [])
  } catch {
    return new Set()
  }
}

function write(set: Set<string>): void {
  const target = pendingFile()
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify({ active: [...set] } satisfies PendingShape), 'utf-8')
    renameSync(tmp, target)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
  }
}

// 标记某会话开始了一轮（runTurn 开头调用）。
export function markActive(conversationId: string): void {
  const set = read()
  if (set.has(conversationId)) return
  set.add(conversationId)
  write(set)
}

// 清除某会话的进行中标记（turn 正常结束/出错/中止时调用）。
export function clearActive(conversationId: string): void {
  const set = read()
  if (!set.delete(conversationId)) return
  write(set)
}

// 读取并清空全部残留（启动时调用，返回上次未正常结束的会话数）。
export function takeStaleActive(): string[] {
  const set = read()
  if (set.size === 0) return []
  write(new Set())
  return [...set]
}
