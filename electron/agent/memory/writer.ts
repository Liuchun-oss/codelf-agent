import type { ChatMessage } from '../providers'
import { CHECKPOINT_SECTION_BUDGETS } from './templates'
import {
  readCheckpointOrTemplate,
  readNotes,
  writeCheckpoint,
  resetNotes,
  readCheckpoint,
  renderCheckpointBudgeted
} from './store'
import { recordDebugEvent } from '../orchestrator/debugLog'

// checkpoint-writer：独立于主 agent 的结构化提取者。
//
// 设计要点（与缓存/稳定性强相关）：
// - writer 通过调用方提供的 `summarize` 回调访问 LLM；该回调在主流程里复用了
//   主会话的 adapter，但 writer 的消息是一组独立的、临时的 system+user，
//   不进入主 historyTurns，也不参与主会话的 promptCacheKey —— 因此对主对话
//   的提示词缓存命中零影响。
// - best-effort：任何失败都被吞掉并记日志，绝不影响主对话继续。
// - 单写者：同一会话同一时刻至多一个 writer 在跑，重入直接跳过。

const inFlight = new Set<string>()

function sectionList(): string {
  return Object.keys(CHECKPOINT_SECTION_BUDGETS)
    .map((title) => `- ${title}`)
    .join('\n')
}

function renderDiscardedTranscript(messages: ChatMessage[], perMessageLimit = 2000): string {
  const lines: string[] = []
  for (const m of messages) {
    const label =
      m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'System'
    if (m.content && m.content.trim()) {
      const text = m.content.trim()
      lines.push(`${label}: ${text.length > perMessageLimit ? text.slice(0, perMessageLimit) + '…' : text}`)
    }
    for (const tc of m.toolCalls ?? []) {
      const args = tc.arguments ?? ''
      lines.push(`Assistant(tool_call): ${tc.name} ${args.length > 400 ? args.slice(0, 400) + '…' : args}`)
    }
  }
  return lines.join('\n')
}

function buildWriterMessages(params: {
  existingCheckpoint: string
  notes: string | undefined
  discarded: ChatMessage[]
}): ChatMessage[] {
  const system =
    '你是一个会话状态提取器（checkpoint writer）。你的任务是把"即将被丢弃的对话片段"中的关键信息，' +
    '增量合并进给定的会话 checkpoint（Markdown，固定 11 个小节）。要求：\n' +
    '1. 严格保留原有的小节标题与顺序，只更新各小节标题下的正文。\n' +
    '2. 这是增量更新：保留 checkpoint 中仍然有效的旧内容，融入新片段的信息，去重、纠正过时项。\n' +
    '3. §1 当前意图尽量逐字引用用户的最新明确请求，不要改写。\n' +
    '4. 不要编造；不确定的信息可省略。如用户明确要求记住凭据/密钥/令牌，可如实记录。\n' +
    '5. 控制篇幅：每个小节聚焦要点，避免大段代码粘贴。\n' +
    '6. 直接输出完整的更新后的 checkpoint Markdown 全文，不要附加任何解释或代码围栏。\n\n' +
    `小节清单（必须全部保留）：\n${sectionList()}`

  const userParts: string[] = []
  userParts.push('## 现有 checkpoint（在此基础上增量更新）\n')
  userParts.push(params.existingCheckpoint)
  if (params.notes && params.notes.trim()) {
    userParts.push('\n\n## 主代理草稿纸 notes（请归类到对应小节后视为已消化）\n')
    userParts.push(params.notes.trim())
  }
  userParts.push('\n\n## 即将被丢弃的对话片段（信息来源）\n')
  userParts.push(renderDiscardedTranscript(params.discarded))

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('') }
  ]
}

export interface RunCheckpointWriterParams {
  sessionId: string
  turnId: string
  model: string
  /** 被压缩丢弃的对话消息（信息来源）。 */
  discardedMessages: ChatMessage[]
  /** 调用 LLM 的回调（复用主会话 adapter，但消息独立、不进主历史）。 */
  summarize: (messages: ChatMessage[]) => Promise<string>
}

/**
 * 派发一次 checkpoint writer。best-effort，返回是否成功写入。
 * 同一会话重入直接跳过，避免并发脏写。
 */
export async function runCheckpointWriter(params: RunCheckpointWriterParams): Promise<boolean> {
  const { sessionId } = params
  if (!sessionId || sessionId === 'default') return false
  if (params.discardedMessages.length === 0) return false
  if (inFlight.has(sessionId)) return false
  inFlight.add(sessionId)
  try {
    const [existingCheckpoint, notes] = await Promise.all([
      readCheckpointOrTemplate(sessionId),
      readNotes(sessionId)
    ])
    const messages = buildWriterMessages({
      existingCheckpoint,
      notes,
      discarded: params.discardedMessages
    })
    const updated = (await params.summarize(messages)).trim()
    if (!updated || !updated.includes('##')) return false
    const result = await writeCheckpoint(sessionId, updated)
    if (!result.ok) return false
    // checkpoint 已消化 notes，重置草稿纸。
    await resetNotes(sessionId)
    recordDebugEvent({
      kind: 'compact',
      sessionId,
      turnId: params.turnId,
      label: params.model,
      detail: `checkpoint-writer updated (${params.discardedMessages.length} msgs)`
    })
    return true
  } catch (e) {
    recordDebugEvent({
      kind: 'compact',
      sessionId,
      turnId: params.turnId,
      label: params.model,
      detail: `checkpoint-writer failed: ${e instanceof Error ? e.message : 'unknown'}`
    })
    return false
  } finally {
    inFlight.delete(sessionId)
  }
}

const DEFAULT_REBUILD_BUDGET = 6000

/**
 * 构建 rebuild 注入块：读取会话 checkpoint.md，按预算裁剪并去除空小节，
 * 包成一段可放进压缩 summary turn 的文本。无内容时返回 null。
 *
 * 缓存说明：调用方只在「压缩瞬间」把它并入一次性生成的 summary turn，
 * 该 turn 之后固定不变，故不产生任何额外的提示词缓存失效。
 */
export async function buildRebuildInjection(params: {
  sessionId: string
  model: string
  budgetTokens?: number
}): Promise<string | null> {
  const { sessionId } = params
  if (!sessionId || sessionId === 'default') return null
  const body = await readCheckpoint(sessionId)
  if (!body) return null
  const rendered = renderCheckpointBudgeted(
    body,
    params.budgetTokens ?? DEFAULT_REBUILD_BUDGET,
    params.model
  )
  if (!rendered) return null
  return [
    '[会话 checkpoint · 由记忆系统重建，供继续当前任务]',
    '以下是早期对话被压缩前提取的结构化会话状态，请据此延续工作；如与近期消息冲突，以近期消息为准。',
    '',
    rendered
  ].join('\n')
}

