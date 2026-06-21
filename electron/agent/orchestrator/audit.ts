import { app } from 'electron'
import { appendFile, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { AuditEntry } from '@shared/agentTypes'



export type AuditAction = AuditEntry['action']
export type { AuditEntry }

const MAX_FIELD_LEN = 2_000

const MAX_LOG_BYTES = 5 * 1024 * 1024

function auditFile(): string {
  return join(app.getPath('userData'), 'audit.log')
}

function clip(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) + '…' : s
}

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const st = await stat(file)
    if (st.size <= MAX_LOG_BYTES) return
    const { rename } = await import('fs/promises')
    await rename(file, file + '.1').catch(() => {})
  } catch {
    
  }
}


export async function recordAudit(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
  try {
    const file = auditFile()
    await rotateIfNeeded(file)
    const line: AuditEntry = {
      ts: new Date().toISOString(),
      action: entry.action,
      tool: entry.tool,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      path: clip(entry.path),
      command: clip(entry.command)
    }
    await appendFile(file, JSON.stringify(line) + '\n', 'utf-8')
  } catch {
    
  }
}


export async function readRecentAudit(limit = 200): Promise<AuditEntry[]> {
  try {
    const raw = await readFile(auditFile(), 'utf-8')
    const lines = raw.split(/\r?\n/).filter((l) => l.trim())
    const out: AuditEntry[] = []
    for (const l of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(l) as AuditEntry)
      } catch {
        
      }
    }
    return out.reverse()
  } catch {
    return []
  }
}
