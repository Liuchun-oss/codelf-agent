import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { appendNote } from '../memory/store'
import { encodeEpisode } from '../memory/encoder'
import { getMemorySettings } from '../settings/agentSettingsStore'

export const APPEND_NOTE_NAME = 'append_note'

const appendNoteSchema = z.object({
  note: z
    .string()
    .min(1)
    .max(4000)
    .describe('要追加到本会话草稿纸的笔记内容。用于记录发现、决策、待办等，供后续记忆整理时归档。')
})

type AppendNoteInput = z.infer<typeof appendNoteSchema>

export const appendNoteTool: Tool<AppendNoteInput> = {
  name: APPEND_NOTE_NAME,
  description:
    '将一条笔记追加到当前会话的草稿纸（notes）。这是你写入长期记忆的唯一入口。\n' +
    '\n' +
    '何时记笔记（主动使用，无需用户指示）：\n' +
    '1. 任务完成后：总结关键步骤、踩过的坑（错误原因+解法）、验证结果。\n' +
    '2. 发现项目约定：代码风格、架构模式、特殊配置、非显而易见的依赖关系。\n' +
    '3. 用户明确偏好：工作习惯、审美倾向、技术栈选择理由。\n' +
    '4. 设计决策：为什么选 A 而非 B、权衡了哪些因素、未来可能的重构点。\n' +
    '5. 待办事项：用户提及但当前未执行的需求、后续优化方向。\n' +
    '\n' +
    '格式建议：用 `## [turn N] 标题` 起头，再写正文（简洁，聚焦要点）。\n' +
    '不要：存放大段代码、可从文件系统检索的内容、临时调试信息。',
  schema: appendNoteSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    if (!getMemorySettings().enabled) {
      return { content: '记忆系统当前已关闭，草稿纸不可写。', isError: true }
    }
    const sessionId = ctx.sessionId
    if (!sessionId || sessionId === 'default') {
      return { content: '当前会话不支持草稿纸写入。', isError: true }
    }
    const result = await appendNote(sessionId, input.note)
    if (!result.ok) {
      return { content: `笔记写入失败：${result.reason ?? '未知原因'}`, isError: true }
    }
    // 阶段 0 双写：额外异步编码进情景记忆库（轨道 A）。fire-and-forget，
    // 失败仅记调试日志，不阻塞、不影响 notes.md 写入结果。
    void encodeEpisode({
      content: input.note,
      scope: 'session',
      workspaceRoot: ctx.memoryWorkspaceRoot ?? ctx.workspaceRoot,
      sessionId,
      kind: 'note'
    }).catch(() => {})
    return { content: '已记入会话草稿纸。' }
  }
}
