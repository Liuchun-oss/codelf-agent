import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types'
import { listSessions, loadSession } from '../orchestrator/sessionPersistence'
import type { PersistedSession } from '@shared/agentTypes'
import {
  LIST_CONVERSATIONS_NAME,
  LIST_CONVERSATIONS_DESCRIPTION,
  READ_CONVERSATION_NAME,
  READ_CONVERSATION_DESCRIPTION
} from '../prompts/tools/conversations'

const MAX_CONTENT_CHARS = 20_000

// 把会话的 workspaceId 与当前工具上下文的 workspaceRoot 做归一化比较，
// 用于把跨对话读取严格限制在同一个工作区内（隐私边界）。
function normalizeWs(value: string | null | undefined): string | null {
  return value ?? null
}

function sameWorkspace(session: PersistedSession, ctx: ToolContext): boolean {
  return normalizeWs(session.workspaceId) === normalizeWs(ctx.workspaceRoot)
}

// 把 "since" 入参解析成时间戳下界；无法解析时返回 undefined（不过滤）。
function parseSince(since: string | undefined): number | undefined {
  if (!since) return undefined
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const key = since.trim().toLowerCase()
  if (key === 'today') return startOfToday
  if (key === 'week') return startOfToday - 7 * 86_400_000
  if (key === 'month') return startOfToday - 30 * 86_400_000
  const parsed = Date.parse(since)
  return Number.isFinite(parsed) ? parsed : undefined
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 16)
  } catch {
    return String(ts)
  }
}

const listConversationsSchema = z.object({
  since: z
    .string()
    .optional()
    .describe('Filter by last-updated time: "today", "week", "month", or an ISO date like "2026-06-15"')
})
type ListConversationsInput = z.infer<typeof listConversationsSchema>

export const listConversationsTool: Tool<ListConversationsInput> = {
  name: LIST_CONVERSATIONS_NAME,
  description: LIST_CONVERSATIONS_DESCRIPTION,
  schema: listConversationsSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    // 仅列出与当前会话同一 workspace 的对话。
    const sessions = listSessions(normalizeWs(ctx.workspaceRoot))
    const since = parseSince(input.since)
    const filtered = since === undefined ? sessions : sessions.filter((s) => s.updatedAt >= since)
    if (filtered.length === 0) {
      return { content: 'No other conversations found in this workspace.' }
    }
    const lines = filtered.map((s) => {
      const current = s.id === ctx.sessionId ? ' (current)' : ''
      const count = s.history.length
      return `- id=${s.id}${current} | updated ${fmtTime(s.updatedAt)} | ${count} msg(s) | ${s.title}`
    })
    let body = lines.join('\n')
    let truncated = false
    if (body.length > MAX_CONTENT_CHARS) {
      body = body.slice(0, MAX_CONTENT_CHARS) + '\n…(results truncated)'
      truncated = true
    }
    return { content: `Found ${filtered.length} conversation(s) in this workspace:\n${body}`, truncated }
  }
}

const readConversationSchema = z.object({
  conversationId: z.string().min(1).describe('The id of the conversation to read (from list_conversations)'),
  query: z.string().optional().describe('Only return messages containing this keyword (case-insensitive)'),
  limit: z.number().int().min(1).max(200).optional().describe('Max messages to return (default 50)')
})
type ReadConversationInput = z.infer<typeof readConversationSchema>

export const readConversationTool: Tool<ReadConversationInput> = {
  name: READ_CONVERSATION_NAME,
  description: READ_CONVERSATION_DESCRIPTION,
  schema: readConversationSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    const session = loadSession(input.conversationId)
    if (!session) {
      return { content: `No conversation found with id "${input.conversationId}".`, isError: true }
    }
    // 隐私边界：只能读同一 workspace 的对话。
    if (!sameWorkspace(session, ctx)) {
      return {
        content: `Conversation "${input.conversationId}" belongs to a different workspace and cannot be read.`,
        isError: true
      }
    }
    const limit = input.limit ?? 50
    const q = input.query?.trim().toLowerCase()
    const selected: { index: number; role: string; content: string }[] = []
    for (let i = 0; i < session.history.length; i++) {
      const m = session.history[i]
      if (typeof m.content !== 'string') continue
      if (q && !m.content.toLowerCase().includes(q)) continue
      selected.push({ index: i, role: m.role, content: m.content })
    }
    if (selected.length === 0) {
      return {
        content: q
          ? `No messages in "${session.title}" match "${input.query}".`
          : `Conversation "${session.title}" has no readable messages.`
      }
    }
    // 取最近的 limit 条（保留原始顺序输出）。
    const sliced = selected.slice(-limit)
    const lines = sliced.map((m) => `#${m.index} [${m.role}] ${m.content}`)
    let body = lines.join('\n\n')
    let truncated = false
    if (body.length > MAX_CONTENT_CHARS) {
      body = body.slice(0, MAX_CONTENT_CHARS) + '\n…(content truncated)'
      truncated = true
    }
    const header = `Conversation "${session.title}" (id=${session.id}), showing ${sliced.length} of ${selected.length} message(s):\n\n`
    return { content: header + body, truncated }
  }
}
