import { promises as fs } from 'fs'
import { writeTextFile } from '../../services/fsService'
import { noteAgentWrite } from '../../services/localWriteRegistry'
import { countTokens, truncateToTokenBudget } from '../context/tokenCounter'
import type { ProviderKind } from '@shared/agentTypes'
import {
  projectMemoryPath,
  globalMemoryPath,
  notesPath,
  sessionMemoryDir,
  checkpointPath
} from './paths'
import {
  MEMORY_TEMPLATE,
  NOTES_TEMPLATE,
  CHECKPOINT_TEMPLATE,
  MEMORY_SECTION_BUDGETS,
  CHECKPOINT_SECTION_BUDGETS,
  GLOBAL_MEMORY_BUDGET
} from './templates'

/** 安全读取文本文件；不存在或出错返回 undefined（不抛）。 */
async function readTextSafe(path: string | null): Promise<string | undefined> {
  if (!path) return undefined
  try {
    return await fs.readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

/** 判断 MEMORY.md 是否只剩模板占位（没有实际内容），用于决定是否注入。 */
export function isMemoryEffectivelyEmpty(body: string | undefined): boolean {
  if (!body) return true
  // 去掉标题行、斜体说明行、占位符与空行后若无实质内容，视为空。
  const meaningful = body
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith('#') &&
        !(l.startsWith('_') && l.endsWith('_')) &&
        l !== '(暂无)' &&
        l !== '(none)' &&
        l !== '(none yet)'
    )
  return meaningful.length === 0
}

export interface MemorySnapshot {
  project?: string
  global?: string
}

/** 读取项目记忆与全局记忆原文（不裁剪）。 */
export async function readMemorySnapshot(workspaceRoot: string | null | undefined): Promise<MemorySnapshot> {
  const [project, global] = await Promise.all([
    readTextSafe(projectMemoryPath(workspaceRoot)),
    readTextSafe(globalMemoryPath())
  ])
  return { project, global }
}

interface Section {
  header: string
  title: string
  lines: string[]
}

/** 按 `## ` 标题切分 markdown，保留前导（# 标题/说明）。 */
function parseSections(text: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = []
  const sections: Section[] = []
  let current: Section | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current)
      current = { header: line, title: line.slice(3).trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  if (current) sections.push(current)
  return { preamble, sections }
}

/**
 * 按节预算裁剪 MEMORY.md：每节正文若超出该节预算则截断；总量再受 totalBudget 兜底。
 * 仅用于注入展示，不改动磁盘文件。
 */
export function renderProjectMemoryBudgeted(
  body: string,
  totalBudget: number,
  model?: string,
  kind?: ProviderKind
): string {
  const { preamble, sections } = parseSections(body)
  const out: string[] = [...preamble]
  for (const sec of sections) {
    const perSection = MEMORY_SECTION_BUDGETS[sec.title] ?? 1500
    const rawBody = sec.lines.join('\n').trim()
    out.push(sec.header)
    if (rawBody) {
      const { text } = truncateToTokenBudget(rawBody, perSection, model, kind)
      out.push(text)
    }
    out.push('')
  }
  const joined = out.join('\n').trim()
  // 总预算兜底：各节相加后仍可能偏大，统一再截断一次。
  const { text } = truncateToTokenBudget(joined, totalBudget, model, kind)
  return text
}

/** 裁剪全局记忆（无分节预算，整体截断）。 */
export function renderGlobalMemoryBudgeted(body: string, model?: string, kind?: ProviderKind): string {
  const { text } = truncateToTokenBudget(body.trim(), GLOBAL_MEMORY_BUDGET, model, kind)
  return text
}

const EMPTY_PLACEHOLDERS = new Set(['(暂无)', '(none)', '(none yet)', '(无)'])

/**
 * 按节预算裁剪会话 checkpoint，并丢弃仅含占位符的小节，使注入紧凑。
 * 全部小节为空时返回 null（无可注入内容）。仅用于 rebuild 注入，不改磁盘。
 */
export function renderCheckpointBudgeted(
  body: string,
  totalBudget: number,
  model?: string,
  kind?: ProviderKind
): string | null {
  const { sections } = parseSections(body)
  const out: string[] = []
  for (const sec of sections) {
    const rawBody = sec.lines
      .filter((l) => !EMPTY_PLACEHOLDERS.has(l.trim()))
      .join('\n')
      .replace(/^_[^]*?_\s*$/m, '') // 去掉斜体说明行
      .trim()
    // 去掉斜体说明后若无实质内容，跳过该节。
    const meaningful = rawBody
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !(l.startsWith('_') && l.endsWith('_')))
    if (meaningful.length === 0) continue
    const perSection = CHECKPOINT_SECTION_BUDGETS[sec.title] ?? 1000
    const { text } = truncateToTokenBudget(meaningful.join('\n'), perSection, model, kind)
    out.push(sec.header, text, '')
  }
  if (out.length === 0) return null
  const joined = out.join('\n').trim()
  const { text } = truncateToTokenBudget(joined, totalBudget, model, kind)
  return text
}

export { countTokens }

/** 确保项目 MEMORY.md 存在；不存在则用模板创建。返回路径或 null。 */
export async function ensureProjectMemory(workspaceRoot: string | null | undefined): Promise<string | null> {
  const path = projectMemoryPath(workspaceRoot)
  if (!path) return null
  const existing = await readTextSafe(path)
  if (existing === undefined) {
    await writeTextFile(path, MEMORY_TEMPLATE)
    noteAgentWrite(path)
  }
  return path
}

/** 读取项目 MEMORY.md 内容（不存在返回 undefined，不创建）。 */
export async function readProjectMemoryContent(
  workspaceRoot: string | null | undefined
): Promise<string | undefined> {
  return readTextSafe(projectMemoryPath(workspaceRoot))
}

/** 覆盖写入项目 MEMORY.md（设置面板内联编辑保存）。 */
export async function writeProjectMemoryContent(
  workspaceRoot: string | null | undefined,
  content: string
): Promise<{ ok: boolean; reason?: string }> {
  const path = projectMemoryPath(workspaceRoot)
  if (!path) return { ok: false, reason: 'invalid-workspace' }
  try {
    await writeTextFile(path, content)
    noteAgentWrite(path)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'write-failed' }
  }
}

/** 读取会话草稿纸内容（不存在返回 undefined）。 */
export async function readNotes(sessionId: string): Promise<string | undefined> {
  return readTextSafe(notesPath(sessionId))
}

/**
 * 向会话草稿纸追加一条记录（主代理唯一写出口）。
 * 文件不存在时先写入模板再追加。返回追加后的字节友好结果。
 */
export async function appendNote(sessionId: string, entry: string): Promise<{ ok: boolean; reason?: string }> {
  const path = notesPath(sessionId)
  const dir = sessionMemoryDir(sessionId)
  if (!path || !dir) return { ok: false, reason: 'invalid-session' }
  const trimmed = entry.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  try {
    const existing = await readTextSafe(path)
    const base = existing ?? NOTES_TEMPLATE
    const next = `${base.replace(/\s+$/, '')}\n\n${trimmed}\n`
    await writeTextFile(path, next)
    noteAgentWrite(path)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'write-failed' }
  }
}

/** 读取会话 checkpoint.md（不存在返回模板，便于 writer 增量更新）。 */
export async function readCheckpointOrTemplate(sessionId: string): Promise<string> {
  const existing = await readTextSafe(checkpointPath(sessionId))
  return existing ?? CHECKPOINT_TEMPLATE
}

/** 读取会话 checkpoint.md 原文（不存在返回 undefined）。 */
export async function readCheckpoint(sessionId: string): Promise<string | undefined> {
  return readTextSafe(checkpointPath(sessionId))
}

/** 覆盖写入会话 checkpoint.md（仅供 writer 使用）。 */
export async function writeCheckpoint(sessionId: string, content: string): Promise<{ ok: boolean; reason?: string }> {
  const path = checkpointPath(sessionId)
  if (!path) return { ok: false, reason: 'invalid-session' }
  const trimmed = content.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  try {
    await writeTextFile(path, trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`)
    noteAgentWrite(path)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'write-failed' }
  }
}

/** 读取会话 notes 后重置为空模板（writer 整理完调用）。 */
export async function resetNotes(sessionId: string): Promise<void> {
  const path = notesPath(sessionId)
  if (!path) return
  try {
    await writeTextFile(path, NOTES_TEMPLATE)
    noteAgentWrite(path)
  } catch {
    // best-effort，失败不影响主流程
  }
}

export type MemorySearchScope = 'project' | 'global' | 'session' | 'all'

export interface MemorySearchHit {
  scope: 'project' | 'global' | 'session'
  source: string
  section: string
  excerpt: string
  score: number
}

/** 把查询切成小写词元（含 CJK），用于关键词打分。 */
function tokenize(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(Boolean)
}

/** 在一段文本里按词元命中数打分，命中则返回带高亮片段。 */
function scoreText(tokens: string[], text: string): { score: number; excerpt: string } | null {
  if (!text.trim()) return null
  const lower = text.toLowerCase()
  let score = 0
  let firstHit = -1
  for (const t of tokens) {
    const idx = lower.indexOf(t)
    if (idx >= 0) {
      score += 1
      if (firstHit < 0 || idx < firstHit) firstHit = idx
    }
  }
  if (score === 0) return null
  const start = Math.max(0, firstHit - 60)
  const raw = text.slice(start, start + 240).trim()
  const excerpt = (start > 0 ? '…' : '') + raw + (start + 240 < text.length ? '…' : '')
  return { score, excerpt }
}

/** 按小节切分并对每节打分，返回命中的小节。 */
function searchInDoc(
  tokens: string[],
  body: string,
  scope: MemorySearchHit['scope'],
  source: string
): MemorySearchHit[] {
  const { sections } = parseSections(body)
  const hits: MemorySearchHit[] = []
  for (const sec of sections) {
    const text = sec.lines
      .filter((l) => !EMPTY_PLACEHOLDERS.has(l.trim()) && !(l.trim().startsWith('_') && l.trim().endsWith('_')))
      .join('\n')
    const scored = scoreText(tokens, text)
    if (scored) hits.push({ scope, source, section: sec.title, excerpt: scored.excerpt, score: scored.score })
  }
  return hits
}

/**
 * 在记忆文件中做关键词检索（无数据库，纯文件遍历 + 词元打分）。
 * 覆盖项目记忆、全局记忆、当前会话 checkpoint，按命中度排序。
 */
export async function searchMemory(params: {
  query: string
  workspaceRoot: string | null | undefined
  sessionId?: string
  scope?: MemorySearchScope
  limit?: number
}): Promise<MemorySearchHit[]> {
  const tokens = tokenize(params.query)
  if (tokens.length === 0) return []
  const scope = params.scope ?? 'all'
  const limit = params.limit ?? 10

  const docs: Array<{ scope: MemorySearchHit['scope']; source: string; body: string | undefined }> = []
  if (scope === 'all' || scope === 'project') {
    docs.push({ scope: 'project', source: 'MEMORY.md', body: await readTextSafe(projectMemoryPath(params.workspaceRoot)) })
  }
  if (scope === 'all' || scope === 'global') {
    docs.push({ scope: 'global', source: 'global/MEMORY.md', body: await readTextSafe(globalMemoryPath()) })
  }
  if ((scope === 'all' || scope === 'session') && params.sessionId) {
    docs.push({ scope: 'session', source: 'checkpoint.md', body: await readCheckpoint(params.sessionId) })
  }

  const hits: MemorySearchHit[] = []
  for (const doc of docs) {
    if (!doc.body) continue
    hits.push(...searchInDoc(tokens, doc.body, doc.scope, doc.source))
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}
