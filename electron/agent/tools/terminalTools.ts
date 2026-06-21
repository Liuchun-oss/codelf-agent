import { z } from 'zod'
import { runCommand } from '../../services/headlessTerminal'
import { createTerminalStreamer } from './terminalStream'
import type { Tool, ToolResult } from './types'
import { TERMINAL_NAME, TERMINAL_DESCRIPTION } from '../prompts/tools/terminal'

const TERMINAL_TIMEOUT_MS = 120_000

const MAX_STDOUT_TAIL_LINES = 200

const terminalSchema = z.object({
  command: z.string().min(1).describe('要执行的 shell 命令（在工作区根目录运行）')
})
type TerminalInput = z.infer<typeof terminalSchema>

function tailLines(text: string, n: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= n) return { text, truncated: false }
  return { text: lines.slice(-n).join('\n'), truncated: true }
}

export const terminalTool: Tool<TerminalInput> = {
  name: TERMINAL_NAME,
  description: TERMINAL_DESCRIPTION,
  schema: terminalSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.workspaceRoot)
      return { content: '当前对话未设置工作目录，无法执行命令。请为对话选择一个目录。', isError: true }

    const streamer = createTerminalStreamer(ctx)
    let res
    try {
      res = await runCommand(input.command, {
        cwd: ctx.workspaceRoot,
        timeoutMs: TERMINAL_TIMEOUT_MS,
        signal: ctx.signal,
        onData: (chunk) => streamer.onData(chunk)
      })
    } finally {
      streamer.flush()
    }

    const stdout = tailLines(res.stdout, MAX_STDOUT_TAIL_LINES)
    const parts: string[] = []
    parts.push(`$ ${input.command}`)
    if (res.awaitingInput) {
      parts.push(
        '(命令疑似在等待交互式输入而被终止：此终端是非交互式的，无法接受 y/n、密码或回车等按键输入。请改用非交互式参数重试，例如加上 -y/--yes/--non-interactive，设置 CI=1 或 DEBIAN_FRONTEND=noninteractive，或用管道预先提供输入，如 "echo y | <命令>"。)'
      )
    } else if (res.timedOut) {
      parts.push('(已超时终止)')
    }
    parts.push(`exit code: ${res.exitCode ?? 'null'}`)
    if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr.trim()}`)
    parts.push(`stdout:\n${stdout.text || '(空)'}`)

    return {
      content: parts.join('\n'),
      isError: res.awaitingInput || (res.exitCode !== 0 && res.exitCode !== null) ? true : res.timedOut,
      truncated: stdout.truncated || res.truncated
    }
  }
}
