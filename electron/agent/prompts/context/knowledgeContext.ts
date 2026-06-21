import { getAgentBehaviorSettings } from '../../settings/agentSettingsStore'
import { searchKnowledge } from '../../../services/knowledge/retriever'
import { listKbs } from '../../../services/knowledge/store'

// 知识库 RAG 自动注入：每轮用用户问题检索知识库，把命中片段渲染成
// 带来源标注的上下文块。注入位置由调用方决定（当前轮问题之前）。
// 该块每轮随问题变化，不写入历史、不进 system，避免破坏 prompt 缓存前缀。

const MAX_BLOCK_CHARS = 12_000

// 检索并渲染知识库上下文块；未启用 / 无库 / 无命中 / 出错时返回 null（best-effort）。
export async function buildKnowledgeContextBlock(query: string): Promise<string | null> {
  const behavior = getAgentBehaviorSettings()
  if (!behavior.knowledgeInjectEnabled) return null
  const q = (query || '').trim()
  if (!q) return null

  try {
    let kbId = behavior.knowledgeKbId
    if (!kbId) {
      const kbs = listKbs()
      if (kbs.length === 0) return null
      kbId = kbs[kbs.length - 1].id
    }

    const res = await searchKnowledge(kbId, q, {
      topK: behavior.knowledgeTopK,
      minScore: behavior.knowledgeMinScore
    })
    if (!res.ok || res.hits.length === 0) return null

    const lines: string[] = [
      '# 知识库参考资料',
      '',
      '以下片段由系统根据用户当前问题，从用户导入的文档知识库中自动检索得到，按相关度排序。',
      '回答时请优先参考这些资料，并在引用时标注来源（文档标题/章节）。若资料与问题无关，可忽略。',
      ''
    ]
    for (const hit of res.hits) {
      const loc = hit.heading ? `${hit.title} › ${hit.heading}` : hit.title
      lines.push(`## ${loc}  (相关度 ${hit.score.toFixed(3)})`)
      lines.push(`来源：${hit.path}`)
      lines.push('')
      lines.push(hit.text)
      lines.push('')
    }

    let block = lines.join('\n')
    if (block.length > MAX_BLOCK_CHARS) {
      block = block.slice(0, MAX_BLOCK_CHARS) + '\n…（参考资料已截断）'
    }
    return block
  } catch {
    // 检索不可用（如原生模块未就绪）时静默跳过，不影响主对话。
    return null
  }
}
