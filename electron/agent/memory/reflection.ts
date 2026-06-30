import { createAdapter, type ChatMessage } from '../providers'
import { getActiveProfileId, getProfileRaw, getActiveProfileApiKey } from '../providers/profileStore'
import { encodeEpisode, scopeForKind } from './encoder'
import { recordDebugEvent } from '../orchestrator/debugLog'

// 反思式提取（方案 A + D）：用默认激活模型，对一段对话做一次性结构化抽取，
// 把"值得长期记住的事实/偏好/决策/待办"提炼成原子条目写入情景库。
//
// 设计要点：
// - best-effort：任何失败都吞掉并记日志，绝不影响主对话。
// - 独立 LLM 调用：消息临时、不进主历史、不污染主会话 promptCache。
// - 抽取而非原文：模型过滤寒暄/操作噪声，只留提炼后的事实，保证低噪声。
// - 单飞：同一会话同一时刻至多一个反思在跑，避免并发重复写。

const inFlight = new Set<string>()

interface ExtractedFact {
  kind?: string
  content?: string
}

const SYSTEM_PROMPT =
  '你是对话记忆提取器。从给定对话片段中，提炼出"值得长期记住、跨会话有用"的信息，' +
  '输出 JSON 数组，每项含 kind 和 content 两个字段。要求：\n' +
  '1. kind 取值之一：identity(身份/称呼)、preference(偏好/习惯)、decision(决策/选型理由)、' +
  'todo(待办/承诺)、convention(项目约定)、fact(其它稳定事实)。\n' +
  '2. content 为简洁中文陈述句，自包含（不依赖上下文也能看懂），逐条独立。\n' +
  '3. 只提炼稳定、可复用的信息；忽略寒暄、纯操作指令、一次性临时内容、可从文件检索的内容。\n' +
  '4. 没有值得记的就输出空数组 []。不要编造。\n' +
  '5. 直接输出 JSON 数组，不要任何解释或代码围栏。'

function renderTranscript(messages: ChatMessage[], perMsgLimit = 1500): string {
  const lines: string[] = []
  for (const m of messages) {
    const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : null
    if (!label) continue
    const text = (m.content ?? '').trim()
    if (!text) continue
    lines.push(`${label}：${text.length > perMsgLimit ? text.slice(0, perMsgLimit) + '…' : text}`)
  }
  return lines.join('\n')
}

function parseFacts(text: string): ExtractedFact[] {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start < 0 || end < 0) return []
    const arr = JSON.parse(cleaned.slice(start, end + 1))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export interface ReflectParams {
  sessionId: string
  messages: ChatMessage[]
  workspaceRoot?: string | null
  activeFile?: string | null
}

/**
 * 对一段对话做反思提取并写入情景库。best-effort，返回写入的条目数。
 * 同一会话重入直接跳过（返回 0）。
 */
export async function reflectAndEncode(p: ReflectParams): Promise<number> {
  const { sessionId } = p
  if (!sessionId || sessionId === 'default') return 0
  if (p.messages.length === 0) return 0
  if (inFlight.has(sessionId)) return 0

  const profileId = getActiveProfileId()
  const profile = profileId ? getProfileRaw(profileId) : null
  if (!profile) return 0

  inFlight.add(sessionId)
  try {
    const transcript = renderTranscript(p.messages)
    if (!transcript.trim()) return 0
    const adapter = createAdapter(profile, getActiveProfileApiKey())
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `## 对话片段\n${transcript}` }
    ]
    let text = ''
    for await (const chunk of adapter.streamChat(
      { model: profile.model, messages, maxOutputTokens: 1024 },
      undefined
    )) {
      if (chunk.type === 'text') text += chunk.text
    }
    const facts = parseFacts(text).filter((f) => f.content && f.content.trim())
    if (facts.length === 0) return 0

    let written = 0
    for (const f of facts) {
      const ok = await encodeEpisode({
        content: f.content!.trim(),
        scope: scopeForKind(f.kind, 'session'),
        workspaceRoot: p.workspaceRoot,
        sessionId,
        kind: f.kind?.trim() || 'fact',
        anchorFile: p.activeFile ?? null,
        model: profile.model
      })
      if (ok) written++
    }
    recordDebugEvent({
      kind: 'memory',
      sessionId,
      turnId: 'reflect',
      label: profile.model,
      detail: `reflected ${written}/${facts.length} facts into episodic`
    })
    return written
  } catch (e) {
    recordDebugEvent({
      kind: 'memory',
      sessionId,
      turnId: 'reflect',
      label: 'episodic',
      detail: `reflect failed: ${e instanceof Error ? e.message : 'unknown'}`
    })
    return 0
  } finally {
    inFlight.delete(sessionId)
  }
}
