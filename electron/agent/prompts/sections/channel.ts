import type { PromptContext } from '../types'

// 通讯通道场景段。仅经由 IM 通道（如微信）转发进来的轮次带 ctx.channel 时输出，
// 桌面端 UI 的 Agent 不带 → 只让远程通道的 agent 感知自己的处境。
//
// 两件事：
//  1) 场景感知：用户正通过 IM 远程聊天、大概率不在电脑旁，回复要适配手机阅读。
//  2) 发文件/截图：用 SendWeixinFile 工具发文件；截图/生成图把链接放进正文即可。
export const FILE_SEND_PROTOCOL = 'codelf-artifact'
// 与 tools/sendWeixinFileTool.ts 的 SEND_WEIXIN_FILE_NAME 保持一致。
// 此处内联常量而非 import，避免 prompts → tools → channels 的循环依赖。
const SEND_FILE_TOOL_NAME = 'SendWeixinFile'

export function getChannelSection(ctx: PromptContext): string | null {
  const ch = ctx.channel
  if (!ch) return null

  const lines: string[] = [
    `# 当前对话场景（通过${ch.label}远程聊天）`,
    '',
    `你现在不是在桌面端界面里工作，而是通过「${ch.label}」和用户进行远程对话。请始终记住以下处境：`,
    `- 用户大概率不在电脑旁，正用手机和你聊天，看到的是${ch.label}里的纯文本消息。`,
    '- 你的回复会被转成纯文本（markdown 不会被渲染），并按段落分条发送，所以：',
    '  - 优先简短、口语化、分点清晰，别一次输出超长内容或大段代码。',
    '  - 不要让用户「去看屏幕」「打开某个文件」「在终端运行」——他多半做不到，需要你代劳并把结果直接说出来。',
    '  - 涉及文件/代码改动时，自己执行并用一两句话汇报结果，而不是把整段贴给用户读。',
    '- 不要向用户播报内部技术步骤（如"正在建桌面会话""正在调用某工具"）。直接做事，只把用户关心的结果告诉他。'
  ]

  if (ch.canSendFile) {
    lines.push(
      '',
      '## 如何把文件发给用户',
      `当用户需要拿到一个文件（文档、压缩包、生成的产物等）时，调用 \`${SEND_FILE_TOOL_NAME}\` 工具，传入该文件的本地路径即可，系统会把文件通过${ch.label}发给用户。`,
      '- 先确保文件已经写到磁盘，再调用工具。',
      '- 路径可以是绝对路径，或相对当前工作区的路径。',
      `- 这是延迟工具：先用 \`SearchExtraTools\` 以 \`select:${SEND_FILE_TOOL_NAME}\` 发现它，再用 \`ExecuteExtraTool\` 执行。`,
      '- 发送是直接的，调用工具即可，不用再向用户解释技术细节。'
    )
  }

  if (ch.canSendImage) {
    lines.push(
      '',
      '## 如何把图片 / 截图发给用户',
      '当用户要图片或要你截屏发给他时：',
      `- 生成类图片（GenerateImage/EditImage）：把工具返回的 \`![](${FILE_SEND_PROTOCOL}://...)\` 图片链接放进回复正文即可。`,
      '- 截图：先用截图工具（如 DesktopScreenshotScreen / DesktopScreenshot）截屏，工具结果里会给出一个 `![](codelf-preview://...)` 形式的图片链接，你把这个链接原样放进回复正文，系统就会自动把截图通过' + ch.label + '发给用户。',
      '不需要把截图另存为文件——直接在正文贴出工具给你的那个图片链接即可。系统会把图片单独作为图片消息发出，正文里的链接本身不会显示给用户。'
    )
  }

  return lines.join('\n')
}

