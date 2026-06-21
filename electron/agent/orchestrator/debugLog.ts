
import type { DebugEventRecord } from '@shared/agentTypes'

export type DebugEventKind = DebugEventRecord['kind']
export type { DebugEventRecord }

const MAX_EVENTS = 300
const MAX_DETAIL_LEN = 500

const buffer: DebugEventRecord[] = []

function clip(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  return s.length > MAX_DETAIL_LEN ? s.slice(0, MAX_DETAIL_LEN) + '…' : s
}


function redact(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  return s
    .replace(/\b(sk|pk|api|key|token)[-_][A-Za-z0-9]{8,}/gi, '$1-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
}

export function recordDebugEvent(entry: Omit<DebugEventRecord, 'ts'>): void {
  buffer.push({
    ts: new Date().toISOString(),
    kind: entry.kind,
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    label: clip(redact(entry.label)),
    detail: clip(redact(entry.detail)),
    durationMs: entry.durationMs
  })
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS)
}


export function readRecentDebugEvents(limit = 200): DebugEventRecord[] {
  return buffer.slice(-limit).reverse()
}


export function clearDebugEvents(): void {
  buffer.length = 0
}
