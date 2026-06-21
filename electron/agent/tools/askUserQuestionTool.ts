import { z } from 'zod'
import type { Tool, ToolResult } from './types'

export const ASK_USER_QUESTION_NAME = 'AskUserQuestion'

export const questionOptionSchema = z.object({
  label: z.string().min(1).max(80).describe('Concise display label for this option'),
  description: z.string().min(1).max(1000).describe('Explanation of this option and its trade-offs'),
  preview: z.string().max(8000).optional().describe('Optional preview content for this option')
})

export const structuredQuestionSchema = z.object({
  question: z.string().min(1).max(1000).describe('The complete question to ask the user'),
  header: z.string().min(1).max(12).describe('Very short label displayed as a chip/tag'),
  options: z.array(questionOptionSchema).min(2).max(4).describe('2-4 available choices; do not include Other'),
  multiSelect: z.boolean().optional().default(false).describe('Allow multiple option selections')
})

const annotationsSchema = z.record(
  z.string(),
  z.object({
    preview: z.string().optional(),
    notes: z.string().optional()
  })
).optional()

export const askUserQuestionSchema = z.object({
  questions: z.array(structuredQuestionSchema).min(1).max(4).describe('Questions to ask the user'),
  answers: z.record(z.string(), z.string()).optional().describe('User answers collected by the UI'),
  annotations: annotationsSchema,
  metadata: z.object({ source: z.string().optional() }).optional()
}).refine((value) => {
  const questionTexts = value.questions.map((q) => q.question)
  if (questionTexts.length !== new Set(questionTexts).size) return false
  for (const q of value.questions) {
    const labels = q.options.map((option) => option.label)
    if (labels.length !== new Set(labels).size) return false
  }
  return true
}, {
  message: 'Question texts must be unique, option labels must be unique within each question'
})

export type AskUserQuestionInput = z.infer<typeof askUserQuestionSchema>

export const askUserQuestionTool: Tool<AskUserQuestionInput> = {
  name: ASK_USER_QUESTION_NAME,
  description: [
    'Asks the user one or more structured multiple-choice questions to gather information, clarify ambiguity, understand preferences, make decisions, or offer choices.',
    'Use this tool when you need to ask the user questions during execution: gather user preferences or requirements, clarify ambiguous instructions, get decisions on implementation choices as you work, or offer choices about what direction to take.',
    'Each question has 2-4 options, optional multiSelect, and the UI always lets the user choose Other/custom text.',
    'If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.',
    'Use the optional preview field on options when presenting concrete artifacts that users need to visually compare, such as UI mockups, code snippets, diagram variations, or configuration examples. Do not use previews for simple preference questions where labels and descriptions suffice.'
  ].join(' '),
  schema: askUserQuestionSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(): Promise<ToolResult> {
    return { content: 'AskUserQuestion 必须由编排层展示给用户并等待回复', isError: true }
  }
}
