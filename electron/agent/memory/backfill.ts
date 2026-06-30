import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { ChatMessage } from '../providers'
import { listSessions } from '../orchestrator/sessionPersistence'
import { reflectAndEncode } from './reflection'
import { recordDebugEvent } from '../orchestrator/debugLog'

// 历史回填（方案 ③）：把记忆系统上线之前积累的历史会话档案，逐个跑反思提取，
// 沉淀进情景库，让系统"一上线就继承用户的全部历史"。
//
// 设计要点：
// - 幂等：已回填的 sessionId 记入 marker 文件，重复触发不会重复花 token。
// - 限量 + 节流：单次最多处理 maxSessions 个会话，会话间留间隔，避免一次性爆 token / 阻塞。
// - best-effort：单个会话失败不影响其余；全程不抛。
// - 复用 reflection 的独立 LLM 调用，不污染任何主会话 promptCache。

interface BackfillState {
  done: string[]
}

function stateFile(): string {
  const dir = join(app.getPath('userData'), 'memory')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'backfill.json')
}

function loadState(): BackfillState {
  try {
    const f = stateFile()
    if (!existsSync(f)) return { done: [] }
    const parsed = JSON.parse(readFileSync(f, 'utf-8')) as Partial<BackfillState>
    return { done: Array.isArray(parsed.done) ? parsed.done : [] }
  } catch {
    return { done: [] }
  }
}

function saveState(state: BackfillState): void {
  try {
    writeFileSync(stateFile(), JSON.stringify({ done: state.done }), 'utf-8')
  } catch {
    // best-effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface BackfillResult {
  scanned: number
  processed: number
  skipped: number
  factsWritten: number
}

export interface BackfillOptions {
  /** 单次最多处理的会话数（防一次性爆 token）。默认 20。传 0/负数表示不限（处理全部）。 */
  maxSessions?: number
  /** 会话间节流间隔毫秒。默认 800ms。 */
  throttleMs?: number
  /** 会话内参与提取的最少消息数（太短的跳过）。默认 2。 */
  minMessages?: number
  /** 进度回调：每处理完一个会话调用一次。 */
  onProgress?: (p: BackfillProgress) => void
}

export interface BackfillProgress {
  total: number
  done: number
  processed: number
  skipped: number
  factsWritten: number
  currentTitle?: string
}

let running = false

/**
 * 执行一次历史回填。best-effort，返回统计。重复触发安全（幂等 + 单飞）。
 */
export async function backfillMemoryFromHistory(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, processed: 0, skipped: 0, factsWritten: 0 }
  if (running) return result
  running = true
  try {
    const maxRaw = opts.maxSessions ?? 20
    const unlimited = maxRaw <= 0
    const maxSessions = unlimited ? Number.MAX_SAFE_INTEGER : maxRaw
    const throttleMs = opts.throttleMs ?? 800
    const minMessages = opts.minMessages ?? 2

    const state = loadState()
    const doneSet = new Set(state.done)
    const sessions = listSessions() // 已按 updatedAt 降序
    result.scanned = sessions.length
    // 待处理总数（未完成的会话），供进度条计算。
    const pending = sessions.filter((s) => !doneSet.has(s.id)).length

    const emit = (currentTitle?: string): void => {
      opts.onProgress?.({
        total: pending,
        done: handledThisRun,
        processed: result.processed,
        skipped: result.skipped,
        factsWritten: result.factsWritten,
        currentTitle
      })
    }

    let processed = 0
    // 仅统计「本次待处理集合」的进展（新处理 + 新跳过的过短会话），
    // 不包含上次已完成、本轮预先跳过的旧会话，避免分子虚高 / 进度条溢出占满。
    let handledThisRun = 0
    for (const s of sessions) {
      if (processed >= maxSessions) break
      if (doneSet.has(s.id)) {
        result.skipped++
        continue
      }
      const msgs: ChatMessage[] = s.history
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim())
        .map((m) => ({ role: m.role as ChatMessage['role'], content: m.content as string }))
      if (msgs.length < minMessages) {
        // 太短的会话直接标记为已处理，避免下次反复扫描。
        doneSet.add(s.id)
        result.skipped++
        handledThisRun++
        saveState({ done: Array.from(doneSet) })
        emit(s.title)
        continue
      }
      emit(s.title)
      const written = await reflectAndEncode({
        sessionId: s.id,
        messages: msgs,
        workspaceRoot: s.workspaceId ?? null
      })
      result.factsWritten += written
      doneSet.add(s.id)
      processed++
      result.processed++
      handledThisRun++
      saveState({ done: Array.from(doneSet) })
      emit(s.title)
      if (throttleMs > 0) await sleep(throttleMs)
    }

    recordDebugEvent({
      kind: 'memory',
      turnId: 'backfill',
      label: 'episodic',
      detail: `backfill: scanned=${result.scanned} processed=${result.processed} skipped=${result.skipped} facts=${result.factsWritten}`
    })
    return result
  } catch (e) {
    recordDebugEvent({
      kind: 'memory',
      turnId: 'backfill',
      label: 'episodic',
      detail: `backfill failed: ${e instanceof Error ? e.message : 'unknown'}`
    })
    return result
  } finally {
    running = false
  }
}
