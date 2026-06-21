import type { ChatMessageView } from '@/stores/agentStore'


function formatTool(m: ChatMessageView): string {
  const name = m.toolName ?? 'tool'
  const arg = m.content?.trim() ? ` \`${m.content.trim()}\`` : ''
  const status =
    m.toolStatus === 'error'
      ? '❌'
      : m.toolStatus === 'running' || m.toolStatus === 'background' || m.toolStatus === 'deferred'
        ? '…'
        : '✓'
  const dur = m.toolDurationMs !== undefined ? ` (${m.toolDurationMs}ms)` : ''
  return `> ${status} **${name}**${arg}${dur}`
}

function formatFileChange(m: ChatMessageView): string {
  const status =
    m.fileStatus === 'applied' ? '已应用' : m.fileStatus === 'rejected' ? '已拒绝' : '待处理'
  return `> 📝 文件修改：\`${m.filePath ?? ''}\`（${status}）`
}

export function exportSessionToMarkdown(title: string, messages: ChatMessageView[]): string {
  const out: string[] = []
  out.push(`# ${title || '对话'}`)
  out.push('')
  out.push(`_导出时间：${new Date().toLocaleString()}_`)
  out.push('')

  for (const m of messages) {
    switch (m.role) {
      case 'user':
        out.push('## 🧑 用户')
        out.push('')
        out.push(m.content.trim())
        out.push('')
        break
      case 'assistant': {
        const body = m.content.trim()
        if (!body && !m.thinking) break
        out.push('## 🤖 助手')
        out.push('')
        if (m.thinking?.trim()) {
          out.push('<details><summary>思考过程</summary>')
          out.push('')
          out.push(m.thinking.trim())
          out.push('')
          out.push('</details>')
          out.push('')
        }
        if (body) {
          out.push(body)
          out.push('')
        }
        break
      }
      case 'tool':
        out.push(formatTool(m))
        out.push('')
        break
      case 'permission':
        out.push(`> 🔐 权限请求：${m.content?.trim() ?? ''}（${m.permissionStatus ?? 'pending'}）`)
        out.push('')
        break
      case 'question':
        out.push(`> 用户确认：${m.content?.trim() ?? ''}`)
        if (m.questionAnswer?.trim()) out.push(`> 回复：${m.questionAnswer.trim()}`)
        out.push('')
        break
      case 'filechange':
        out.push(formatFileChange(m))
        out.push('')
        break
      case 'error':
        out.push(`> ⚠️ 错误：${m.content.trim()}`)
        out.push('')
        break
      case 'notice':
        out.push(`> ℹ️ ${m.content.trim()}`)
        out.push('')
        break
      default:
        break
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}


export function exportFileName(title: string): string {
  const safe = (title || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const stamp = new Date().toISOString().slice(0, 10)
  return `${safe}-${stamp}.md`
}
