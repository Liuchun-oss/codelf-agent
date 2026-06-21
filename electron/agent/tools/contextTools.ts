import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { CONTEXT_INSPECT_DESCRIPTION, CONTEXT_INSPECT_NAME } from '../prompts/tools/contextTools'

const contextInspectSchema = z.object({
  includeMessages: z.boolean().optional().describe('Include a compact per-message listing')
})

export const contextInspectTool: Tool<z.infer<typeof contextInspectSchema>> = {
  name: CONTEXT_INSPECT_NAME,
  description: CONTEXT_INSPECT_DESCRIPTION,
  schema: contextInspectSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(_input, ctx): Promise<ToolResult> {
    if (!ctx.inspectContext) {
      return { content: 'ContextInspect is unavailable in this context.', isError: true }
    }
    return ctx.inspectContext()
  }
}
