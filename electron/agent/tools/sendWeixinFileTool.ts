import { z } from 'zod'
import { isAbsolute, resolve as resolvePath, basename } from 'path'
import { stat } from 'fs/promises'
import type { Tool, ToolResult } from './types'

export const SEND_WEIXIN_FILE_NAME = 'SendWeixinFile'
export const SEND_WEIXIN_FILE_DESCRIPTION = '把本地文件作为附件发送给当前微信会话的用户。'

const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      [
        '要发送的本地文件路径（绝对路径，或相对当前工作区的路径）。',
        '用途：仅在你正通过微信通道与用户对话、且用户需要拿到某个文件（文档、压缩包、生成的产物、保存到磁盘的图片等）时使用本工具。',
        '约定：',
        '- 文件必须已经写到磁盘，再调用本工具。',
        '- 发送是直接的，调用即可，不要再向用户解释技术细节。',
        '- 不要用本工具发纯文本回复（正常文字直接回复即可）。',
        '- GenerateImage/EditImage 产出的图片正常输出其 markdown 链接即可由系统发送；本工具用于显式发送任意本地文件。'
      ].join('\n')
    ),
  fileName: z
    .string()
    .optional()
    .describe('（可选）发送给用户时显示的文件名。不填则用源文件名。')
})

type Input = z.infer<typeof schema>

export const sendWeixinFileTool: Tool<Input> = {
  name: SEND_WEIXIN_FILE_NAME,
  description: SEND_WEIXIN_FILE_DESCRIPTION,
  schema,
  readOnly: true,
  concurrencySafe: false,
  deferred: true,
  async execute(input, ctx): Promise<ToolResult> {
    const sessionId = ctx.sessionId
    if (!sessionId) {
      return { content: '无法确定当前会话，发送文件失败。', isError: true }
    }

    // 解析路径：绝对路径直接用；相对路径相对当前工作区。
    let absPath = input.path.trim()
    if (!isAbsolute(absPath)) {
      if (!ctx.workspaceRoot) {
        return {
          content: 'path 是相对路径，但当前没有工作区可解析。请改用绝对路径。',
          isError: true
        }
      }
      absPath = resolvePath(ctx.workspaceRoot, absPath)
    }

    try {
      const st = await stat(absPath)
      if (!st.isFile()) {
        return { content: `路径不是一个文件：${absPath}`, isError: true }
      }
    } catch {
      return { content: `文件不存在或无法访问：${absPath}`, isError: true }
    }

    const fileName = (input.fileName?.trim() || basename(absPath)).slice(0, 255)
    const { getChannelManager } = await import('../../channels/manager')
    const ok = await getChannelManager().sendFileToConversation(sessionId, absPath, fileName)
    if (!ok) {
      return {
        content:
          '发送失败：当前不是有效的微信会话，或该通道不支持发送文件（图片/文件需要已登录的微信通道）。',
        isError: true
      }
    }
    return { content: `已通过微信把文件「${fileName}」发送给用户。` }
  }
}
