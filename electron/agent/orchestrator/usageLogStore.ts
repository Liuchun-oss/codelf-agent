import { app } from 'electron'
import { appendFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type {
  ProviderKind,
  UsageLogEntry,
  UsageStatsQuery,
  UsageStatsResult,
  UsageStatsProfileRow
} from '@shared/agentTypes'

function usageLogFile(): string {
  return join(app.getPath('userData'), 'usage-log.jsonl')
}

export function appendUsageLog(entry: UsageLogEntry): void {
  if (!entry || !entry.profileId) return
  const input = Math.max(0, Math.round(entry.inputTokens || 0))
  const output = Math.max(0, Math.round(entry.outputTokens || 0))
  if (input <= 0 && output <= 0) return
  try {
    appendFileSync(usageLogFile(), JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // 用量日志为辅助数据，写失败不应影响对话流程
  }
}

function readEntries(): UsageLogEntry[] {
  const file = usageLogFile()
  if (!existsSync(file)) return []
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    return []
  }
  const out: UsageLogEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line) as Partial<UsageLogEntry>
      if (typeof obj.ts !== 'number' || typeof obj.profileId !== 'string') continue
      out.push({
        ts: obj.ts,
        profileId: obj.profileId,
        model: typeof obj.model === 'string' ? obj.model : '',
        kind: (obj.kind as ProviderKind) ?? 'openai',
        inputTokens: Number(obj.inputTokens) || 0,
        outputTokens: Number(obj.outputTokens) || 0,
        apiInputTokens: typeof obj.apiInputTokens === 'number' ? obj.apiInputTokens : undefined,
        apiOutputTokens: typeof obj.apiOutputTokens === 'number' ? obj.apiOutputTokens : undefined,
        cacheReadInputTokens:
          typeof obj.cacheReadInputTokens === 'number' ? obj.cacheReadInputTokens : undefined,
        cacheCreationInputTokens:
          typeof obj.cacheCreationInputTokens === 'number' ? obj.cacheCreationInputTokens : undefined,
        sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
        turnId: typeof obj.turnId === 'string' ? obj.turnId : undefined
      })
    } catch {
      continue
    }
  }
  return out
}

export function queryUsageStats(query: UsageStatsQuery = {}): UsageStatsResult {
  const { from, to, profileId } = query
  const entries = readEntries()
  const rows = new Map<string, UsageStatsProfileRow>()
  let totalInput = 0
  let totalOutput = 0
  let totalTurns = 0

  for (const e of entries) {
    if (from != null && e.ts < from) continue
    if (to != null && e.ts > to) continue
    if (profileId && e.profileId !== profileId) continue

    let row = rows.get(e.profileId)
    if (!row) {
      row = {
        profileId: e.profileId,
        model: e.model,
        kind: e.kind,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turns: 0
      }
      rows.set(e.profileId, row)
    }
    // 模型名以最新一条记录为准（同一 profile 可能改过模型名）
    if (e.model) row.model = e.model
    row.kind = e.kind
    row.inputTokens += e.inputTokens
    row.outputTokens += e.outputTokens
    row.totalTokens += e.inputTokens + e.outputTokens
    row.turns += 1

    totalInput += e.inputTokens
    totalOutput += e.outputTokens
    totalTurns += 1
  }

  const perProfile = [...rows.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  return {
    perProfile,
    total: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      turns: totalTurns
    }
  }
}
