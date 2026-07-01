import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AgentTask, ContentReplacementRecord, PersistedSession, PersistedChatMessage, PersistedFileChange, TokenUsage } from '@shared/agentTypes'



const SCHEMA_VERSION = 1

function sessionsDir(): string {
  const dir = join(app.getPath('userData'), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}


function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

function sessionFile(id: string): string {
  return join(sessionsDir(), `${id}.jsonl`)
}

function serialize(session: PersistedSession): string {
  const lines: string[] = []
  lines.push(
    JSON.stringify({
      v: SCHEMA_VERSION,
      t: 'meta',
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      workspaceId: session.workspaceId ?? null,
      tokenUsage: session.tokenUsage ?? null
    })
  )
  for (const m of session.messages) lines.push(JSON.stringify({ t: 'msg', m }))
  for (const h of session.history) lines.push(JSON.stringify({ t: 'hist', m: h }))
  for (const task of session.tasks ?? []) lines.push(JSON.stringify({ t: 'task', m: task }))
  for (const r of session.replacementRecords ?? []) lines.push(JSON.stringify({ t: 'repl', m: r }))
  for (const name of session.discoveredDeferredTools ?? []) lines.push(JSON.stringify({ t: 'deferred_tool', m: name }))
  for (const fc of session.fileChanges ?? []) lines.push(JSON.stringify({ t: 'filechange', m: fc }))
  return lines.join('\n') + '\n'
}


export function saveSession(session: PersistedSession): void {
  if (!session || !isSafeId(session.id)) return
  const file = sessionFile(session.id)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, serialize(session), 'utf-8')
  renameSync(tmp, file)
}

function parseReplacementRecord(value: unknown): ContentReplacementRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<ContentReplacementRecord>
  if (record.kind !== 'tool-result' || typeof record.toolUseId !== 'string' || !record.toolUseId) return null
  return {
    kind: 'tool-result',
    toolUseId: record.toolUseId,
    ...(typeof record.replacement === 'string' ? { replacement: record.replacement } : {})
  }
}

function parseAgentTask(value: unknown): AgentTask | null {
  if (!value || typeof value !== 'object') return null
  const task = value as Partial<AgentTask>
  if (typeof task.id !== 'string' || !task.id) return null
  if (typeof task.subject !== 'string' || !task.subject) return null
  if (typeof task.description !== 'string') return null
  if (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'completed') return null
  const now = Date.now()
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    ...(typeof task.activeForm === 'string' && task.activeForm ? { activeForm: task.activeForm } : {}),
    status: task.status,
    createdAt: typeof task.createdAt === 'number' ? task.createdAt : now,
    updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : now
  }
}

function parseFileChange(value: unknown): PersistedFileChange | null {
  if (!value || typeof value !== 'object') return null
  const fc = value as Partial<PersistedFileChange>
  if (typeof fc.changeId !== 'string' || !fc.changeId) return null
  if (typeof fc.path !== 'string' || !fc.path) return null
  const enc = fc.encoding
  if (enc !== 'utf8' && enc !== 'utf8bom' && enc !== 'utf16le' && enc !== 'utf16be') return null
  return {
    changeId: fc.changeId,
    path: fc.path,
    encoding: enc,
    oldExisted: fc.oldExisted === true,
    oldDataBase64: typeof fc.oldDataBase64 === 'string' ? fc.oldDataBase64 : '',
    newContent: typeof fc.newContent === 'string' ? fc.newContent : '',
    state: fc.state === 'reverted' ? 'reverted' : 'applied'
  }
}

function parseFile(raw: string): PersistedSession | null {
  const messages: unknown[] = []
  const history: PersistedChatMessage[] = []
  const tasks: AgentTask[] = []
  const replacementRecords: ContentReplacementRecord[] = []
  const discoveredDeferredTools: string[] = []
  const fileChanges: PersistedFileChange[] = []
  let meta: { id: string; title: string; createdAt: number; updatedAt: number; workspaceId: string | null; tokenUsage: TokenUsage | null } | null = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.t === 'meta' && typeof obj.id === 'string') {
      meta = {
        id: obj.id,
        title: typeof obj.title === 'string' ? obj.title : '新对话',
        createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
        updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
        workspaceId: typeof obj.workspaceId === 'string' ? obj.workspaceId : null,
        tokenUsage:
          obj.tokenUsage && typeof obj.tokenUsage === 'object'
            ? (obj.tokenUsage as TokenUsage)
            : null
      }
    } else if (obj.t === 'msg' && 'm' in obj) {
      messages.push(obj.m)
    } else if (obj.t === 'hist' && obj.m && typeof obj.m === 'object') {
      const m = obj.m as PersistedChatMessage
      if (typeof m.content === 'string' && typeof m.role === 'string') history.push(m)
    } else if (obj.t === 'task') {
      const task = parseAgentTask(obj.m)
      if (task) tasks.push(task)
    } else if (obj.t === 'repl') {
      const record = parseReplacementRecord(obj.m)
      if (record) replacementRecords.push(record)
    } else if (obj.t === 'deferred_tool' && typeof obj.m === 'string' && obj.m.trim()) {
      discoveredDeferredTools.push(obj.m.trim())
    } else if (obj.t === 'filechange') {
      const fc = parseFileChange(obj.m)
      if (fc) fileChanges.push(fc)
    }
  }
  if (!meta) return null
  return { ...meta, messages, history, tasks, replacementRecords, discoveredDeferredTools, fileChanges }
}


export function loadSession(id: string): PersistedSession | null {
  if (!isSafeId(id)) return null
  const file = sessionFile(id)
  if (!existsSync(file)) return null
  try {
    return parseFile(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}


export function listSessions(workspaceId?: string | null): PersistedSession[] {
  const dir = sessionsDir()
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const out: PersistedSession[] = []
  for (const f of files) {
    const id = f.slice(0, -'.jsonl'.length)
    const s = loadSession(id)
    if (!s) continue
    
    if (workspaceId !== undefined) {
      const sessionWs = s.workspaceId ?? null
      if (sessionWs !== (workspaceId ?? null)) continue
    }
    out.push(s)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}


export function deleteSessionFile(id: string): void {
  if (!isSafeId(id)) return
  const file = sessionFile(id)
  try {
    rmSync(file, { force: true })
  } catch {
    
  }
}

export interface HistorySearchMatch {
  
  index: number
  role: string
  
  excerpt: string
}

function makeExcerpt(content: string, query: string, radius = 160): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return content.length > radius * 2 ? content.slice(0, radius * 2) + '…' : content
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + query.length + radius)
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
}


export function searchSessionHistory(
  id: string,
  query: string,
  limit = 20
): HistorySearchMatch[] {
  const q = query.trim()
  if (!q) return []
  const session = loadSession(id)
  if (!session) return []
  const out: HistorySearchMatch[] = []
  for (let i = 0; i < session.history.length; i++) {
    const m = session.history[i]
    if (typeof m.content !== 'string') continue
    if (m.content.toLowerCase().includes(q.toLowerCase())) {
      out.push({ index: i, role: m.role, excerpt: makeExcerpt(m.content, q) })
      if (out.length >= limit) break
    }
  }
  return out
}
