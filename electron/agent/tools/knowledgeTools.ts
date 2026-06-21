import { z } from 'zod'
import { searchKnowledge } from '../../services/knowledge/retriever'
import { listKbs } from '../../services/knowledge/store'
import { getAgentBehaviorSettings } from '../settings/agentSettingsStore'
import type { Tool, ToolResult } from './types'
import { KNOWLEDGE_SEARCH_NAME, KNOWLEDGE_SEARCH_DESCRIPTION } from '../prompts/tools/knowledgeSearch'

const MAX_CONTENT_CHARS = 60_000

const knowledgeSearchSchema = z.object({
  query: z.string().min(1).describe('Natural-language question or keywords (Chinese preferred).'),
  kbId: z.string().optional().describe('Knowledge base id; omit to use the most recent one.')
})
type KnowledgeSearchInput = z.infer<typeof knowledgeSearchSchema>

export const knowledgeSearchTool: Tool<KnowledgeSearchInput> = {
  name: KNOWLEDGE_SEARCH_NAME,
  description: KNOWLEDGE_SEARCH_DESCRIPTION,
  schema: knowledgeSearchSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input): Promise<ToolResult> {
    let kbId = input.kbId
    // 未指定知识库时，默认用最近创建的一个。
    if (!kbId) {
      let kbs
      try {
        kbs = listKbs()
      } catch (e) {
        return { content: e instanceof Error ? e.message : '知识库不可用', isError: true }
      }
      if (kbs.length === 0) {
        return { content: '尚未创建任何知识库。请在「设置 → 知识库」中创建并导入文档后再试。' }
      }
      kbId = kbs[kbs.length - 1].id
    }

    const behavior = getAgentBehaviorSettings()
    const res = await searchKnowledge(kbId, input.query, {
      topK: behavior.knowledgeTopK,
      minScore: behavior.knowledgeMinScore
    })
    if (!res.ok) return { content: res.error ?? '检索失败', isError: true }
    if (res.hits.length === 0) {
      return { content: '知识库中未找到相关内容。可尝试换用同义词或更具体的表述重试。' }
    }

    const lines: string[] = []
    for (const hit of res.hits) {
      const loc = hit.heading ? `${hit.title} › ${hit.heading}` : hit.title
      lines.push(`# ${loc}  (相关度 ${hit.score.toFixed(3)})`)
      lines.push(`  来源：${hit.path}`)
      const preview = hit.text.length > 800 ? hit.text.slice(0, 800) + '…' : hit.text
      for (const l of preview.split('\n')) lines.push(`    ${l}`)
    }
    const header = `相关文档片段（语义检索，按相关度排序，共 ${res.hits.length} 段）：\n`
    let body = lines.join('\n')
    let truncated = false
    if (body.length > MAX_CONTENT_CHARS) {
      body = body.slice(0, MAX_CONTENT_CHARS) + '\n…（结果已截断）'
      truncated = true
    }
    return { content: header + body, truncated }
  }
}
