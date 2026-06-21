import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { searchMemory } from '../memory/store'
import { getMemorySettings } from '../settings/agentSettingsStore'

export const SEARCH_MEMORY_NAME = 'search_memory'

const MAX_CONTENT_CHARS = 16_000

const searchMemorySchema = z.object({
  query: z.string().min(1).describe('要在长期记忆中检索的关键词或短语'),
  scope: z
    .enum(['all', 'project', 'global', 'session'])
    .optional()
    .describe('检索范围：all(默认)/project(项目记忆)/global(全局偏好)/session(当前会话 checkpoint)'),
  limit: z.number().int().min(1).max(30).optional().describe('最多返回的命中数（默认 10）')
})

type SearchMemoryInput = z.infer<typeof searchMemorySchema>

export const searchMemoryTool: Tool<SearchMemoryInput> = {
  name: SEARCH_MEMORY_NAME,
  description:
    '在长期记忆中按关键词检索：项目记忆(MEMORY.md)、全局用户偏好、当前会话的结构化 checkpoint。' +
    '当你需要回忆此前积累的项目约定、决策、偏好或被压缩掉的会话状态时使用。返回按命中度排序的小节片段。',
  schema: searchMemorySchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    if (!getMemorySettings().enabled) {
      return { content: '记忆系统当前已关闭。' }
    }
    const hits = await searchMemory({
      query: input.query,
      workspaceRoot: ctx.workspaceRoot,
      sessionId: ctx.sessionId,
      scope: input.scope,
      limit: input.limit
    })
    if (hits.length === 0) {
      return { content: `长期记忆中未找到与“${input.query}”相关的内容。可尝试更换更独特的关键词，或用 search_history 检索原始对话。` }
    }
    const lines = hits.map(
      (h) => `### [${h.scope}] ${h.source} › ${h.section}\n${h.excerpt}`
    )
    let body = lines.join('\n\n')
    let truncated = false
    if (body.length > MAX_CONTENT_CHARS) {
      body = body.slice(0, MAX_CONTENT_CHARS) + '\n…(结果已截断)'
      truncated = true
    }
    return { content: `命中 ${hits.length} 条（按相关度排序）：\n\n${body}`, truncated }
  }
}
