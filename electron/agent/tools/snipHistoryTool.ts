import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { SNIP_HISTORY_DESCRIPTION, SNIP_HISTORY_NAME } from '../prompts/tools/snipHistory'

export const snipHistorySchema = z
  .object({
    reason: z.string().min(1).max(500).describe('Why the history can be snipped'),
    turnIds: z.array(z.string().min(1)).max(100).optional().describe('Explicit turn ids to remove from model context'),
    beforeTurnId: z.string().min(1).optional().describe('Remove all earlier turns before this turn id'),
    keepRecentTurns: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Remove older turns while keeping this many most recent turns')
  })
  .refine((v) => Boolean(v.turnIds?.length || v.beforeTurnId || v.keepRecentTurns), {
    message: 'Provide turnIds, beforeTurnId, or keepRecentTurns'
  })

type SnipHistoryInput = z.infer<typeof snipHistorySchema>

export const snipHistoryTool: Tool<SnipHistoryInput> = {
  name: SNIP_HISTORY_NAME,
  description: SNIP_HISTORY_DESCRIPTION,
  schema: snipHistorySchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.requestSnipHistory) {
      return { content: 'snip_history is unavailable in this context.', isError: true }
    }
    return ctx.requestSnipHistory(input)
  }
}
