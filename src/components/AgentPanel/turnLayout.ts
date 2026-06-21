import type { ChatMessageView } from '@/stores/agentStore'


export function findLastUserMessage(messages: ChatMessageView[]): ChatMessageView | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i]
  }
  return null
}

export type MessageSegment =
  | { kind: 'user'; message: ChatMessageView }
  
  | { kind: 'assistant_group'; messages: ChatMessageView[] }
  | { kind: 'activity'; tools: ChatMessageView[] }
  
  | { kind: 'command'; message: ChatMessageView }
  | { kind: 'changes'; files: ChatMessageView[] }
  | { kind: 'permission'; message: ChatMessageView }
  | { kind: 'question'; message: ChatMessageView }
  | { kind: 'error'; message: ChatMessageView }
  | { kind: 'notice'; message: ChatMessageView }
  | { kind: 'subagent'; message: ChatMessageView }
  
  | { kind: 'tasklist'; turnId: string | undefined }

const TERMINAL_TOOL_NAMES = new Set([
  'run_terminal_cmd',
  'PowerShell',
  'StartTerminalTask',
  'ReadTerminalTask',
  'StopTerminalTask',
  'WriteTerminalTask'
])

export function isTerminalTool(toolName: string | undefined): boolean {
  return toolName !== undefined && TERMINAL_TOOL_NAMES.has(toolName)
}

function flushTools(tools: ChatMessageView[], out: MessageSegment[]): void {
  if (tools.length > 0) out.push({ kind: 'activity', tools: [...tools] })
}

function flushFiles(files: ChatMessageView[], out: MessageSegment[]): void {
  if (files.length > 0) out.push({ kind: 'changes', files: [...files] })
}

function isFileChangeTool(message: ChatMessageView): boolean {
  return message.toolName === 'edit_file' || message.toolName === 'write_file'
}

function removeTrailingFileChangeTool(tools: ChatMessageView[]): ChatMessageView[] {
  if (tools.length === 0) return tools
  const last = tools[tools.length - 1]
  if (!isFileChangeTool(last)) return tools
  return tools.slice(0, -1)
}


export function buildMessageSegments(messages: ChatMessageView[]): MessageSegment[] {
  const out: MessageSegment[] = []
  let tools: ChatMessageView[] = []
  let files: ChatMessageView[] = []

  const flush = (): void => {
    flushTools(tools, out)
    tools = []
    flushFiles(files, out)
    files = []
  }

  for (const m of messages) {
    switch (m.role) {
      case 'user':
        flush()
        out.push({ kind: 'user', message: m })
        break
      case 'assistant': {
        flushTools(tools, out)
        tools = []
        flushFiles(files, out)
        files = []
        const last = out[out.length - 1]
        if (last?.kind === 'assistant_group') {
          last.messages.push(m)
        } else {
          out.push({ kind: 'assistant_group', messages: [m] })
        }
        break
      }
      case 'tool':
        if (m.toolName === 'TodoWrite') {
          flush()
          
          if (!out.some((seg) => seg.kind === 'tasklist')) {
            out.push({ kind: 'tasklist', turnId: m.turnId })
          }
        } else if (isTerminalTool(m.toolName)) {
          flush()
          out.push({ kind: 'command', message: m })
        } else if (m.toolName === 'run_subagent') {
          continue
        } else {
          flushFiles(files, out)
          files = []
          tools.push(m)
        }
        break
      case 'filechange':
        tools = removeTrailingFileChangeTool(tools)
        flushTools(tools, out)
        tools = []
        files.push(m)
        break
      case 'permission':
        flush()
        out.push({ kind: 'permission', message: m })
        break
      case 'question':
        flush()
        out.push({ kind: 'question', message: m })
        break
      case 'error':
        flush()
        out.push({ kind: 'error', message: m })
        break
      case 'notice':
        flush()
        out.push({ kind: 'notice', message: m })
        break
      case 'subagent':
        flush()
        out.push({ kind: 'subagent', message: m })
        break
      default:
        break
    }
  }
  flush()
  return out
}

export interface ActivityCounts {
  files: number
  searches: number
  commands: number
  other: number
}

export function summarizeActivity(tools: ChatMessageView[]): ActivityCounts {
  const c: ActivityCounts = { files: 0, searches: 0, commands: 0, other: 0 }
  for (const t of tools) {
    const name = t.toolName ?? ''
    if (name === 'read_file' || name === 'list_dir' || name === 'write_file' || name === 'edit_file') {
      c.files++
    } else if (name === 'grep' || name === 'search') {
      c.searches++
    } else if (isTerminalTool(name)) {
      c.commands++
    } else {
      c.other++
    }
  }
  return c
}

export function formatActivitySummary(counts: ActivityCounts): string {
  const parts: string[] = []
  if (counts.files > 0) parts.push(`查看 ${counts.files} 个路径`)
  if (counts.searches > 0) parts.push(`搜索 ${counts.searches} 次`)
  if (counts.commands > 0) parts.push(`命令 ${counts.commands} 次`)
  if (counts.other > 0) parts.push(`其他工具 ${counts.other}`)
  return parts.length > 0 ? parts.join(' · ') : '工具活动'
}
