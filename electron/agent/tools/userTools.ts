import { z } from 'zod'
import type { Tool, ToolResult } from './types'

export const ASK_USER_NAME = 'ask_user'

export const askUserSchema = z.object({
  question: z.string().min(1).describe('The concise question to ask the user before continuing.'),
  suggestions: z
    .array(z.string().min(1))
    .max(6)
    .optional()
    .describe('Optional short answer suggestions the user can click.')
})

export type AskUserInput = z.infer<typeof askUserSchema>

export const askUserTool: Tool<AskUserInput> = {
  name: ASK_USER_NAME,
  description:
    'Ask the user a clarifying question and wait for their answer before continuing. Use this only when blocked by missing requirements or a decision the user must make.',
  schema: askUserSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(): Promise<ToolResult> {
    return { content: 'ask_user 必须由编排层展示给用户并等待回复', isError: true }
  }
}
