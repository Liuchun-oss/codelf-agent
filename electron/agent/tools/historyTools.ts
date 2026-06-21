import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { searchSessionHistory } from '../orchestrator/sessionPersistence'
import { SEARCH_HISTORY_NAME, SEARCH_HISTORY_DESCRIPTION } from '../prompts/tools/searchHistory'

const MAX_CONTENT_CHARS = 20_000

const searchHistorySchema = z.object({
  query: z.string().min(1).describe('Keyword or phrase to find in the conversation history'),
  limit: z.number().int().min(1).max(50).optional().describe('Max matches to return (default 20)')
})
type SearchHistoryInput = z.infer<typeof searchHistorySchema>


export const searchHistoryTool: Tool<SearchHistoryInput> = {
  name: SEARCH_HISTORY_NAME,
  description: SEARCH_HISTORY_DESCRIPTION,
  schema: searchHistorySchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    const sessionId = ctx.sessionId
    if (!sessionId) {
      return { content: 'No active session; conversation history is unavailable.', isError: true }
    }
    const matches = searchSessionHistory(sessionId, input.query, input.limit ?? 20)
    if (matches.length === 0) {
      return { content: `No earlier messages match "${input.query}".` }
    }
    const lines = matches.map((m) => `#${m.index} [${m.role}] ${m.excerpt}`)
    let body = lines.join('\n')
    let truncated = false
    if (body.length > MAX_CONTENT_CHARS) {
      body = body.slice(0, MAX_CONTENT_CHARS) + '\n…(results truncated)'
      truncated = true
    }
    const header = `Found ${matches.length} match(es) for "${input.query}":\n`
    return { content: header + body, truncated }
  }
}
