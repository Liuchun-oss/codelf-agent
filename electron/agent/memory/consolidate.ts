import { createAdapter, type ChatMessage } from '../providers'
import { getActiveProfileId, getProfileRaw, getActiveProfileApiKey } from '../providers/profileStore'
import { resolveProjectId } from './paths'
import { ensureProjectMemory, readProjectMemoryContent, writeProjectMemoryContent } from './store'
import { consolidationCandidates, markConsolidated } from './episodicStore'
import { recordDebugEvent } from '../orchestrator/debugLog'

// 睡眠巩固（机制 5）：空闲/会话结束时，把高显著情景记忆"回放"并蒸馏成稳定语义知识，
// 增量写进项目 MEMORY.md；被巩固的情景标记 consolidated 并加速衰减（海马副本弱化）。
//
// 设计要点：
// - 复用 memoryPromotion 同款"独立 LLM 调用"模式：消息临时、不进主历史、不污染主会话 promptCache。
// - best-effort：任何失败都吞掉并记日志，绝不影响主对话。
// - 单飞：同一项目同一时刻至多一个巩固在跑。

const inFlight = new Set<string>()

const MIN_CANDIDATES = 3

function buildMessages(existingMemory: string, episodes: string): ChatMessage[] {
  const system =
    '你是项目记忆巩固器。任务：把"会话中沉淀的高价值情景记忆"抽象成稳定的项目知识，' +
    '增量合并进项目 MEMORY.md（Markdown，固定 4 小节：项目背景 / 规则 / 架构决策 / 跨会话稳定知识）。要求：\n' +
    '1. 严格保留原有 4 个小节标题与顺序，只更新各小节标题下的正文。\n' +
    '2. 增量更新：保留仍有效的旧内容，融入新知识，去重、纠正过时项。\n' +
    '3. 只纳入可长期复用、跨会话有价值的知识；把具体情景抽象成规律（去掉一次性的时间/临时细节）。\n' +
    '4. 不要编造；不确定的省略。直接输出更新后的 MEMORY.md 全文，不要附加解释或代码围栏。'
  const user =
    '## 现有 MEMORY.md（在此基础上增量更新）\n' +
    existingMemory +
    '\n\n## 本次回放的高价值情景记忆（来源，请甄别抽象后合并）\n' +
    episodes
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/**
 * 对某工作区执行一次睡眠巩固。best-effort，返回是否实际写入 MEMORY.md。
 */
export async function consolidateProject(workspaceRoot: string): Promise<boolean> {
  if (!workspaceRoot) return false
  const projectId = resolveProjectId(workspaceRoot)
  if (inFlight.has(projectId)) return false

  const profileId = getActiveProfileId()
  const profile = profileId ? getProfileRaw(profileId) : null
  if (!profile) return false

  inFlight.add(projectId)
  try {
    const candidates = consolidationCandidates(projectId, 12)
    if (candidates.length < MIN_CANDIDATES) return false

    const episodes = candidates
      .map((c, i) => `${i + 1}. [${c.kind}${c.anchorFile ? ` · ${c.anchorFile}` : ''}] ${c.content}`)
      .join('\n')

    await ensureProjectMemory(workspaceRoot)
    const existing = (await readProjectMemoryContent(workspaceRoot)) ?? ''

    const adapter = createAdapter(profile, getActiveProfileApiKey())
    const messages = buildMessages(existing, episodes)
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

    markConsolidated(candidates.map((c) => c.id))
    recordDebugEvent({
      kind: 'memory',
      turnId: 'consolidate',
      label: profile.model,
      detail: `consolidated ${candidates.length} episodes into MEMORY.md`
    })
    return true
  } catch (e) {
    recordDebugEvent({
      kind: 'memory',
      turnId: 'consolidate',
      label: 'episodic',
      detail: `consolidation failed: ${e instanceof Error ? e.message : 'unknown'}`
    })
    return false
  } finally {
    inFlight.delete(projectId)
  }
}
