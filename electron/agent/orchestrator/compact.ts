import type { ProviderKind } from '@shared/agentTypes'
import type { ChatMessage } from '../providers'
import { countChatMessagesTokens, countTokens } from '../context/tokenCounter'



export interface CompactMetadata {
  type: 'auto' | 'manual'
  reason: 'threshold' | 'predictive'
  summarizedTurnIds: string[]
  preCompactTokens: number
  createdAt: number
}

export interface CompactTurn {
  turnId: string
  messages: ChatMessage[]
  compactMeta?: CompactMetadata
}

const DEFAULT_RESERVED_OUTPUT_TOKENS = 20_000
const DEFAULT_AUTOCOMPACT_BUFFER_TOKENS = 13_000
const TOOL_RESULT_GROWTH_ESTIMATE = 15_000

const PER_MESSAGE_TRANSCRIPT_LIMIT = 2_000

// 压缩后希望把"保留的近期对话"压到约占上下文窗口的这个比例，
// 这样单次压缩能腾出大量空间，后续很久不必再压（缓存只被破坏这一次）。
const POST_COMPACT_TARGET_RATIO = 0.25
// summary 自身的预留（compaction 输出上限是 1024，留些余量计入预算）。
const SUMMARY_RESERVE_TOKENS = 1_500
// 无论预算多小，至少保留这么多 turn，避免把刚发生的上下文也压掉。
const MIN_KEEP_RECENT_TURNS = 2

export interface MaybeCompactOptions {
  turns: CompactTurn[]
  model: string
  kind: ProviderKind
  contextWindow: number
  
  summarize: (messages: ChatMessage[]) => Promise<string>
  thresholdRatio?: number
  keepRecentTurns?: number
  
  systemTokens?: number
  
  maxOutputTokens?: number
  
  predictive?: boolean
  
  restoreHints?: string
  
  force?: boolean
}

export interface MaybeCompactResult {
  turns: CompactTurn[]
  compacted: boolean
  reason?: CompactMetadata['reason']
  preCompactTokens?: number
}


export function estimateTurnsTokens(
  turns: CompactTurn[],
  model: string,
  kind: ProviderKind
): number {
  const flat = turns.flatMap((t) => t.messages.map((m) => ({ role: m.role, content: m.content })))
  return countChatMessagesTokens(flat, model, kind)
}

export function getEffectiveContextWindow(opts: { contextWindow: number; maxOutputTokens?: number }): number {
  const reserved = Math.min(opts.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS, DEFAULT_RESERVED_OUTPUT_TOKENS)
  return Math.max(1, opts.contextWindow - reserved)
}

export function getAutocompactBufferTokens(effectiveWindow: number): number {
  if (effectiveWindow >= 800_000) return 50_000
  if (effectiveWindow >= 400_000) return 30_000
  return DEFAULT_AUTOCOMPACT_BUFFER_TOKENS
}

export function getAutoCompactThreshold(opts: { contextWindow: number; maxOutputTokens?: number }): number {
  const effectiveWindow = getEffectiveContextWindow(opts)
  return Math.max(1, effectiveWindow - getAutocompactBufferTokens(effectiveWindow))
}

export function estimateMaxTurnGrowth(maxOutputTokens?: number): number {
  return Math.min(maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS, DEFAULT_RESERVED_OUTPUT_TOKENS) + TOOL_RESULT_GROWTH_ESTIMATE
}

export function estimateCompactionTotalTokens(opts: {
  turns: CompactTurn[]
  model: string
  kind: ProviderKind
  systemTokens?: number
}): number {
  return (opts.systemTokens ?? 0) + estimateTurnsTokens(opts.turns, opts.model, opts.kind)
}


export function needsCompaction(opts: {
  turns: CompactTurn[]
  model: string
  kind: ProviderKind
  contextWindow: number
  systemTokens?: number
  thresholdRatio?: number
  maxOutputTokens?: number
  predictive?: boolean
}): boolean {
  const total = estimateCompactionTotalTokens(opts)
  if (opts.thresholdRatio !== undefined) {
    if (total > opts.contextWindow * opts.thresholdRatio) return true
  } else {
    const threshold = getAutoCompactThreshold(opts)
    if (total > threshold) return true
  }
  if (!opts.predictive) return false
  return total > getEffectiveContextWindow(opts) - estimateMaxTurnGrowth(opts.maxOutputTokens)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `…(${s.length - max} more chars)`
}


function renderTranscript(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const label =
      m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'System'
    if (m.content && m.content.trim()) {
      lines.push(`${label}: ${truncate(m.content.trim(), PER_MESSAGE_TRANSCRIPT_LIMIT)}`)
    }
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        lines.push(`Assistant(tool_call): ${tc.name} ${truncate(tc.arguments ?? '', 400)}`)
      }
    }
  }
  return lines.join('\n')
}


export function buildCompactionMessages(oldMessages: ChatMessage[]): ChatMessage[] {
  const system =
    'You are compacting a long conversation so it can continue without exceeding the context window. ' +
    'Write a concise but complete summary that a developer agent can rely on to continue the work. ' +
    'Preserve: the user goals and constraints, decisions made, important file paths and symbols, ' +
    'code changes already applied, command results that matter, and any unresolved tasks or open questions. ' +
    'Do not invent details. If a specific detail is uncertain, note that it can be recovered with the ' +
    'search_history tool rather than guessing. Reply with the summary only, in the same language as the conversation.'
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Summarize the following earlier conversation:\n\n${renderTranscript(oldMessages)}`
    }
  ]
}


export async function maybeCompactTurns(opts: MaybeCompactOptions): Promise<MaybeCompactResult> {
  // 未显式指定 keepRecentTurns 时，按窗口 25% 预算反推保留量：单次压缩压得更狠，
  // 腾出大量空间，后续长时间无需再压，从而把"缓存被破坏"限制为偶发的一次。
  // 显式传入（如反应式压缩需要尽量压小）时尊重调用方的值。
  const keep =
    opts.keepRecentTurns ??
    computeKeepRecentTurnsByBudget({
      turns: opts.turns,
      model: opts.model,
      kind: opts.kind,
      contextWindow: opts.contextWindow,
      systemTokens: opts.systemTokens
    })
  if (opts.turns.length <= keep) return { turns: opts.turns, compacted: false }
  const preCompactTokens = estimateCompactionTotalTokens({
    turns: opts.turns,
    model: opts.model,
    kind: opts.kind,
    systemTokens: opts.systemTokens
  })
  const crossesThreshold = needsCompaction({
    turns: opts.turns,
    model: opts.model,
    kind: opts.kind,
    contextWindow: opts.contextWindow,
    systemTokens: opts.systemTokens,
    thresholdRatio: opts.thresholdRatio,
    maxOutputTokens: opts.maxOutputTokens
  })
  const crossesPredictiveThreshold =
    opts.predictive === true &&
    !crossesThreshold &&
    needsCompaction({
      turns: opts.turns,
      model: opts.model,
      kind: opts.kind,
      contextWindow: opts.contextWindow,
      systemTokens: opts.systemTokens,
      thresholdRatio: opts.thresholdRatio,
      maxOutputTokens: opts.maxOutputTokens,
      predictive: true
    })
  if (!opts.force && !crossesThreshold && !crossesPredictiveThreshold) {
    return { turns: opts.turns, compacted: false }
  }

  const old = opts.turns.slice(0, opts.turns.length - keep)
  const recent = opts.turns.slice(-keep)
  const oldMessages = old.flatMap((t) => t.messages)
  if (oldMessages.length === 0) return { turns: opts.turns, compacted: false }

  const summary = (await opts.summarize(buildCompactionMessages(oldMessages))).trim()
  if (!summary) return { turns: opts.turns, compacted: false }

  const reason: CompactMetadata['reason'] = crossesPredictiveThreshold ? 'predictive' : 'threshold'
  const summarizedTurnIds = old.map((t) => t.turnId)
  const contentParts = [
    '[Summary of earlier conversation, auto-compacted to save context]',
    `Reason: ${reason}`,
    `Summarized turns: ${summarizedTurnIds.join(', ') || '(none)'}`,
    '',
    summary
  ]
  if (opts.restoreHints?.trim()) {
    contentParts.push('', '[Post-compact restoration hints]', opts.restoreHints.trim())
  }

  const summaryTurn: CompactTurn = {
    turnId: `compact-${Date.now()}`,
    compactMeta: {
      type: 'auto',
      reason,
      summarizedTurnIds,
      preCompactTokens,
      createdAt: Date.now()
    },
    messages: [
      {
        role: 'user',
        content: contentParts.join('\n')
      }
    ]
  }
  return { turns: [summaryTurn, ...recent], compacted: true, reason, preCompactTokens }
}


export function estimateSystemTokens(systemText: string, model: string, kind: ProviderKind): number {
  return countTokens(systemText, model, kind)
}


/**
 * 按"压缩后总量 ≈ 窗口 × POST_COMPACT_TARGET_RATIO"反推应保留多少个最近 turn。
 * 从最新 turn 往前累加其 token，直到逼近预算上限即停。预算 = 目标总量 − system − summary 预留。
 * 该策略与模型窗口大小成比例：大窗口多保留、小窗口少保留，单次压缩后都能腾出充足空间。
 */
export function computeKeepRecentTurnsByBudget(opts: {
  turns: CompactTurn[]
  model: string
  kind: ProviderKind
  contextWindow: number
  systemTokens?: number
  targetRatio?: number
}): number {
  const ratio = opts.targetRatio ?? POST_COMPACT_TARGET_RATIO
  const target = opts.contextWindow * ratio
  const budget = target - (opts.systemTokens ?? 0) - SUMMARY_RESERVE_TOKENS
  if (budget <= 0) return MIN_KEEP_RECENT_TURNS

  let used = 0
  let keep = 0
  // 从最近的 turn 向前累加，直到再加一个就超预算。
  for (let i = opts.turns.length - 1; i >= 0; i--) {
    const turnTokens = countChatMessagesTokens(
      opts.turns[i].messages.map((m) => ({ role: m.role, content: m.content })),
      opts.model,
      opts.kind
    )
    if (keep > 0 && used + turnTokens > budget) break
    used += turnTokens
    keep++
  }
  return Math.max(MIN_KEEP_RECENT_TURNS, keep)
}
