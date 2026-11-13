import type { ProviderKind } from '@shared/agentTypes'
import type { ChatMessage } from '../providers'
import { countChatMessagesTokensFull, countTokens } from '../context/tokenCounter'
import { clampRequestMaxOutputTokens } from '../providers/modelMetadata'



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

  // 请求里除历史对话与 system 文本之外的固定开销（工具定义 JSON schema、动态上下文块、
  // 本轮用户消息等）。压缩判断必须把它算进去，否则阈值算小了、真实请求早就越界了。
  requestOverheadTokens?: number
  
  predictive?: boolean
  
  restoreHints?: string
  
  force?: boolean
  
  // 压缩来源标记：用户主动触发（/compact）时传 'manual'，默认 'auto'。仅影响 summary turn 的元数据与提示文案。
  type?: CompactMetadata['type']
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
  return countChatMessagesTokensFull(turns.flatMap((t) => t.messages), model, kind)
}

// 工具定义（JSON schema）也随每次请求发送：核心工具 + MCP 工具常有数万 token。
// 以前压缩判断只算 system 文本，工具定义完全没计入，于是本地以为「还在阈值内」、
// 服务端已按真实总量越界。
export function estimateToolDefsTokens(toolDefs: unknown, model: string, kind: ProviderKind): number {
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) return 0
  return countTokens(JSON.stringify(toolDefs), model, kind)
}

// max_tokens 与 prompt 共用同一个上下文窗口（DeepSeek / vLLM 等按 `prompt + max_tokens ≤ 窗口`
// 校验）。所以这里必须按「真正发出去的 max_tokens」预留输出预算，否则会出现本地算着"才用
// 70%、很安全"、服务端直接 400 超限的情况：窗口 1M + max_tokens 393216 时，prompt 实际只能
// 到 655360，而按旧逻辑（封顶预留 20k）要等到 930000 才压缩，中间 27 万 token 全在雷区里。
const MAX_OUTPUT_RESERVE_RATIO = 0.4

export function getEffectiveContextWindow(opts: { contextWindow: number; maxOutputTokens?: number }): number {
  const requested =
    opts.maxOutputTokens === undefined
      ? DEFAULT_RESERVED_OUTPUT_TOKENS
      : clampRequestMaxOutputTokens(opts.maxOutputTokens)
  // 极端小窗口下也要留出可用 prompt 空间，故预留不超过窗口的 40%。
  const reserve = Math.min(requested, Math.max(1, Math.floor(opts.contextWindow * MAX_OUTPUT_RESERVE_RATIO)))
  return Math.max(1, opts.contextWindow - reserve)
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
  requestOverheadTokens?: number
}): number {
  return (
    (opts.systemTokens ?? 0) +
    (opts.requestOverheadTokens ?? 0) +
    estimateTurnsTokens(opts.turns, opts.model, opts.kind)
  )
}


export function needsCompaction(opts: {
  turns: CompactTurn[]
  model: string
  kind: ProviderKind
  contextWindow: number
  systemTokens?: number
  thresholdRatio?: number
  maxOutputTokens?: number
  requestOverheadTokens?: number
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

// 把要摘要的旧消息按 token 预算切成多批，使每批（含摘要 system/user 包装的开销）
// 都能安全塞进当前模型窗口。用于"历史远超窗口"（如跨模型从大窗口切到小窗口）时分批摘要。
function chunkMessagesByTokenBudget(
  messages: ChatMessage[],
  perChunkBudget: number,
  model: string,
  kind: ProviderKind
): ChatMessage[][] {
  const chunks: ChatMessage[][] = []
  let cur: ChatMessage[] = []
  let curTokens = 0
  for (const m of messages) {
    const t = countChatMessagesTokensFull([m], model, kind)
    // 单条就超预算：自成一批（renderTranscript 内有每条 2000 字截断，能兜住）。
    if (t >= perChunkBudget) {
      if (cur.length) {
        chunks.push(cur)
        cur = []
        curTokens = 0
      }
      chunks.push([m])
      continue
    }
    if (cur.length && curTokens + t > perChunkBudget) {
      chunks.push(cur)
      cur = []
      curTokens = 0
    }
    cur.push(m)
    curTokens += t
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

// 分批摘要：历史装不下单次摘要请求时，按批摘要再合并（map-reduce）。
// 让小窗口模型也能逐步把超大历史压下去，避免"摘要请求本身超窗口"导致整体失败。
async function summarizeInBatches(opts: {
  oldMessages: ChatMessage[]
  model: string
  kind: ProviderKind
  contextWindow: number
  systemTokens?: number
  maxOutputTokens?: number
  summarize: (messages: ChatMessage[]) => Promise<string>
}): Promise<string> {
  // 每批预算：有效窗口扣掉摘要 system 提示与输出预留，再留 40% 安全余量。
  const effective = getEffectiveContextWindow({
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens
  })
  const perChunkBudget = Math.max(2_000, Math.floor(effective * 0.6) - (opts.systemTokens ?? 0))

  const fullOnce = countChatMessagesTokensFull(buildCompactionMessages(opts.oldMessages), opts.model, opts.kind)
  // 单次摘要请求就能装下 → 走原路径，行为与改动前完全一致。
  if (fullOnce <= perChunkBudget) {
    return (await opts.summarize(buildCompactionMessages(opts.oldMessages))).trim()
  }

  // 否则分批摘要，再把分批摘要合并成最终摘要。
  const chunks = chunkMessagesByTokenBudget(opts.oldMessages, perChunkBudget, opts.model, opts.kind)
  const partials: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const s = (await opts.summarize(buildCompactionMessages(chunks[i]))).trim()
    if (s) partials.push(`[Part ${i + 1}/${chunks.length}]\n${s}`)
  }
  if (partials.length === 0) return ''
  if (partials.length === 1) return partials[0].replace(/^\[Part 1\/1\]\n/, '')

  // reduce：把各批摘要当作"对话"再摘要一次，合成连贯总摘要。
  const mergeInput: ChatMessage[] = [
    { role: 'user', content: partials.join('\n\n') }
  ]
  const merged = (await opts.summarize(buildCompactionMessages(mergeInput))).trim()
  // 合并摘要若失败，退而求其次直接拼接各批摘要（总比丢失全部历史好）。
  return merged || partials.join('\n\n')
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
    systemTokens: opts.systemTokens,
    requestOverheadTokens: opts.requestOverheadTokens
  })
  const crossesThreshold = needsCompaction({
    turns: opts.turns,
    model: opts.model,
    kind: opts.kind,
    contextWindow: opts.contextWindow,
    systemTokens: opts.systemTokens,
    thresholdRatio: opts.thresholdRatio,
    maxOutputTokens: opts.maxOutputTokens,
    requestOverheadTokens: opts.requestOverheadTokens
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
      requestOverheadTokens: opts.requestOverheadTokens,
      predictive: true
    })
  if (!opts.force && !crossesThreshold && !crossesPredictiveThreshold) {
    return { turns: opts.turns, compacted: false }
  }

  const old = opts.turns.slice(0, opts.turns.length - keep)
  const recent = opts.turns.slice(-keep)
  const oldMessages = old.flatMap((t) => t.messages)
  if (oldMessages.length === 0) return { turns: opts.turns, compacted: false }

  // 分批摘要：历史装不下单次摘要请求时（如跨模型切到小窗口），按批摘要再合并，
  // 避免"摘要请求本身超窗口"导致压缩失败、进而整轮报错。装得下时等价于原单次摘要。
  const summary = (
    await summarizeInBatches({
      oldMessages,
      model: opts.model,
      kind: opts.kind,
      contextWindow: opts.contextWindow,
      systemTokens: opts.systemTokens,
      maxOutputTokens: opts.maxOutputTokens,
      summarize: opts.summarize
    })
  ).trim()
  if (!summary) return { turns: opts.turns, compacted: false }

  const reason: CompactMetadata['reason'] = crossesPredictiveThreshold ? 'predictive' : 'threshold'
  const summarizedTurnIds = old.map((t) => t.turnId)
  const contentParts = [
    opts.type === 'manual'
      ? '[Summary of earlier conversation, manually compacted by user to save context]'
      : '[Summary of earlier conversation, auto-compacted to save context]',
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
      type: opts.type ?? 'auto',
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
    const turnTokens = countChatMessagesTokensFull(opts.turns[i].messages, opts.model, opts.kind)
    if (keep > 0 && used + turnTokens > budget) break
    used += turnTokens
    keep++
  }
  return Math.max(MIN_KEEP_RECENT_TURNS, keep)
}

// ---------------------------------------------------------------------------
// 单次请求体哨兵
//
// 自动压缩只在「turn 开始时」判断一次，而一轮内的工具循环（读大文件、长终端输出、
// 并行工具批次）会把 prompt 一路推高；此时既没有压缩检查，反应式压缩又不允许在
// 已有多条消息时生效，于是下一次请求直接被服务端 400 顶回来。这里在每轮发请求前
// 做一次廉价预估，超出就地把最老的工具输出换成占位符（保留最近几条），换回空间。
// ---------------------------------------------------------------------------

const REQUEST_GUARD_MARGIN_RATIO = 0.05
const REQUEST_GUARD_MARGIN_MAX = 20_000
// 字符级网关估算相对上限留到这个比例以下时，直接放行、不做精确分词——
// 1M token 的精确分词约 0.4s，每轮都跑会拖慢工具循环。0.75 配合下方按代码调过的
// 除数（实测代码 ~3.1 字符/token），最坏也只到真实值 78% 的上限，留足余量。
const GUARD_EXACT_COUNT_RATIO = 0.75
// 无论多紧张，最近这么多条工具结果保持原样——它们通常是模型此刻正在用的。
const MIN_KEEP_RECENT_TOOL_RESULTS = 4
// 比这还短的工具结果没必要换占位符（省不了多少，反而丢信息）。
const SHRINK_MIN_CHARS = 800
// 占位符里保留的开头长度：前几百字符常含文件路径/预览，值得留着。
const SHRINK_HEAD_CHARS = 600

// 单次请求的安全上限：窗口减去实际发送的 max_tokens，再留一点余量吸收
// tiktoken 与厂商分词器的口径差异。
export function getRequestGuardLimit(opts: { contextWindow: number; maxOutputTokens?: number }): number {
  const windowLimit = getEffectiveContextWindow(opts)
  const margin = Math.min(REQUEST_GUARD_MARGIN_MAX, Math.floor(windowLimit * REQUEST_GUARD_MARGIN_RATIO))
  return Math.max(1, windowLimit - margin)
}

// 廉价网关估算：CJK 按 1.2 token/字（实际约 0.7~1，故意偏高），其余按 3.2 字符/token
// （实测代码 ~3.1、英文单词 ~5，取偏保守的一侧）。只用来判断「肯定没超、不必精确算」。
function estimatePromptTokensGateway(messages: ChatMessage[]): number {
  let cjk = 0
  let others = 0
  const scan = (text: string): void => {
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0
      if (code >= 0x4e00 && code <= 0x9fff) cjk++
      else others++
    }
  }
  for (const m of messages) {
    scan(m.content ?? '')
    for (const tc of m.toolCalls ?? []) scan(tc.name + (tc.arguments ?? ''))
  }
  return Math.ceil(cjk * 1.2 + others / 3.2)
}

export interface RequestGuardResult {
  limit: number
  before: number
  after: number
  shrunkToolResults: number
  overLimit: boolean
}

/**
 * 把一次请求（messages + tools）压到安全上限以内。
 * 只动 role==='tool' 的旧消息内容，不改消息数量、不动 tool_use/tool_result 配对，
 * 对 Anthropic 的严格校验也安全。调用方传入的是「即将发送的消息数组」，因其中的
 * 消息对象与历史共享引用，降载结果会自然同步进历史。
 */
export function guardRequestSize(opts: {
  messages: ChatMessage[]
  toolDefs?: unknown
  model: string
  kind: ProviderKind
  contextWindow: number
  maxOutputTokens?: number
  keepRecentToolResults?: number
  // 跳过廉价快路径，强制精确核算（用于「服务端已经报超限」之后的补救重试）。
  force?: boolean
}): RequestGuardResult {
  const limit = getRequestGuardLimit(opts)
  const toolTokens = estimateToolDefsTokens(opts.toolDefs, opts.model, opts.kind)

  if (!opts.force) {
    const gateway = estimatePromptTokensGateway(opts.messages) + toolTokens
    if (gateway < limit * GUARD_EXACT_COUNT_RATIO) {
      return { limit, before: gateway, after: gateway, shrunkToolResults: 0, overLimit: false }
    }
  }

  const before = countChatMessagesTokensFull(opts.messages, opts.model, opts.kind) + toolTokens
  if (before <= limit) {
    return { limit, before, after: before, shrunkToolResults: 0, overLimit: false }
  }

  const candidates: number[] = []
  for (let i = 0; i < opts.messages.length; i++) {
    if (opts.messages[i].role === 'tool' && (opts.messages[i].content?.length ?? 0) > SHRINK_MIN_CHARS) {
      candidates.push(i)
    }
  }
  const keep = opts.keepRecentToolResults ?? MIN_KEEP_RECENT_TOOL_RESULTS
  const shrinkable = candidates.slice(0, Math.max(0, candidates.length - keep))

  let total = before
  let shrunk = 0
  for (const idx of shrinkable) {
    if (total <= limit) break
    const m = opts.messages[idx]
    const original = countChatMessagesTokensFull([m], opts.model, opts.kind)
    const head = m.content.slice(0, SHRINK_HEAD_CHARS)
    m.content =
      `${head}\n\n（该工具输出过长（原始约 ${original} tokens），为留出上下文空间已省略绝大部分内容。` +
      '需要完整内容时请重新执行对应工具调用或按路径重新读取。）'
    total -= original - countChatMessagesTokensFull([m], opts.model, opts.kind)
    shrunk++
  }

  return { limit, before, after: total, shrunkToolResults: shrunk, overLimit: total > limit }
}
