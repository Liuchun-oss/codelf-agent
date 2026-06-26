// 记忆自动晋升（策划书 6.6 第 4 点）：把会话 checkpoint 里的稳定知识
// 增量合并进工作区的 MEMORY.md，实现跨会话"越用越懂"。
//
// 设计要点：
// - best-effort：任何失败都吞掉，绝不影响主对话。
// - 复用 checkpoint writer 同款"独立 LLM 调用"模式（不污染主会话 promptCache）。
// - 只提取稳定小节（§3 约束 / §7 跨任务发现 / §10 设计决策），其余易变内容不晋升。
// - 安全：prompt 明令禁止写入密钥/令牌；物理路径由系统侧计算，Agent 不接触。

import { createAdapter, type ChatMessage } from '../providers'
import { getActiveProfileId, getProfileRaw, getActiveProfileApiKey } from '../providers/profileStore'
import { readCheckpoint, ensureProjectMemory, readProjectMemoryContent, writeProjectMemoryContent } from './store'
import { recordDebugEvent } from '../orchestrator/debugLog'

const inFlight = new Set<string>()

// 从 checkpoint 全文里抽取指定稳定小节的正文。
function extractStableSections(checkpoint: string): string {
  const wanted = ['§3 本会话约束', '§7 跨任务发现', '§10 设计决策']
  const lines = checkpoint.split('\n')
  const out: string[] = []
  let capturing = false
  for (const line of lines) {
    const header = line.match(/^##\s+(.+?)\s*$/)
    if (header) {
      capturing = wanted.some((w) => header[1].includes(w))
      if (capturing) out.push(line)
      continue
    }
    if (capturing) out.push(line)
  }
  return out.join('\n').trim()
}

// 判断抽取出的内容是否有实质（排除占位符/斜体说明）。
function hasMeaningfulContent(text: string): boolean {
  const placeholders = new Set(['(暂无)', '(none)', '(无)'])
  return text
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('_') && !placeholders.has(l))
}

function buildPromotionMessages(existingMemory: string, stable: string): ChatMessage[] {
  const system =
    '你是项目记忆维护器。任务：把"会话中沉淀的稳定知识"增量合并进项目 MEMORY.md（Markdown，固定 4 个小节：' +
    '项目背景 / 规则 / 架构决策 / 跨会话稳定知识）。要求：\n' +
    '1. 严格保留原有 4 个小节标题与顺序，只更新各小节标题下的正文。\n' +
    '2. 增量更新：保留 MEMORY.md 中仍有效的旧内容，融入新知识，去重、纠正过时项。\n' +
    '3. 只纳入可长期复用、跨会话有价值的知识；一次性/易变信息（运行时状态、临时文件等）不要写入。\n' +
    '4. 会话约束归入"规则"，设计决策归入"架构决策"，反复验证的事实归入"跨会话稳定知识"。\n' +
    '5. 不要编造；不确定的省略。如用户明确要求记住某些凭据/密钥/令牌等信息，可如实写入。\n' +
    '6. 控制篇幅，聚焦要点。直接输出更新后的 MEMORY.md 全文，不要附加解释或代码围栏。'

  const user =
    '## 现有 MEMORY.md（在此基础上增量更新）\n' +
    existingMemory +
    '\n\n## 本会话沉淀的稳定知识（来源，请甄别后合并）\n' +
    stable

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/**
 * 把某会话 checkpoint 的稳定知识晋升进指定工作区的 MEMORY.md。
 * best-effort，返回是否实际写入。
 */
export async function promoteSessionMemory(params: {
  sessionId: string
  workspaceRoot: string
}): Promise<boolean> {
  const { sessionId, workspaceRoot } = params
  if (!sessionId || !workspaceRoot) return false
  if (inFlight.has(sessionId)) return false

  const profileId = getActiveProfileId()
  const profile = profileId ? getProfileRaw(profileId) : null
  if (!profile) return false

  inFlight.add(sessionId)
  try {
    const checkpoint = await readCheckpoint(sessionId)
    if (!checkpoint) return false
    const stable = extractStableSections(checkpoint)
    if (!hasMeaningfulContent(stable)) return false

    await ensureProjectMemory(workspaceRoot)
    const existing = (await readProjectMemoryContent(workspaceRoot)) ?? ''

    const adapter = createAdapter(profile, getActiveProfileApiKey())
    const messages = buildPromotionMessages(existing, stable)
    let text = ''
    for await (const chunk of adapter.streamChat(
      { model: profile.model, messages, maxOutputTokens: 4096 },
      undefined
    )) {
      if (chunk.type === 'text') text += chunk.text
    }
    const updated = text.trim()
    if (!updated || !updated.includes('##')) return false

    const result = await writeProjectMemoryContent(workspaceRoot, updated)
    if (!result.ok) return false

    recordDebugEvent({
      kind: 'compact',
      sessionId,
      turnId: 'promote',
      label: profile.model,
      detail: 'memory promoted to MEMORY.md'
    })
    return true
  } catch (e) {
    recordDebugEvent({
      kind: 'compact',
      sessionId,
      turnId: 'promote',
      label: profile.model,
      detail: `memory promotion failed: ${e instanceof Error ? e.message : 'unknown'}`
    })
    return false
  } finally {
    inFlight.delete(sessionId)
  }
}
