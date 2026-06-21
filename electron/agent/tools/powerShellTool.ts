import { z } from 'zod'
import { runCommand } from '../../services/headlessTerminal'
import { resolveAnyPath } from './paths'
import { createTerminalStreamer } from './terminalStream'
import type { Tool, ToolResult } from './types'
import { POWERSHELL_DESCRIPTION, POWERSHELL_NAME } from '../prompts/tools/powerShell'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const MAX_STDOUT_TAIL_LINES = 300

const powerShellSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute (PowerShell on Windows, bash/zsh on macOS/Linux)'),
  working_directory: z.string().optional().describe('Optional workspace-relative working directory'),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe('Timeout in milliseconds')
})

type PowerShellInput = z.infer<typeof powerShellSchema>

function tailLines(text: string, n: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= n) return { text, truncated: false }
  return { text: lines.slice(-n).join('\n'), truncated: true }
}

export const powerShellTool: Tool<PowerShellInput> = {
  name: POWERSHELL_NAME,
  description: POWERSHELL_DESCRIPTION,
  schema: powerShellSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.workspaceRoot) return { content: '未打开工作区，无法执行命令', isError: true }

    let cwd = ctx.workspaceRoot
    try {
      if (input.working_directory) cwd = resolveAnyPath(ctx.workspaceRoot, input.working_directory)
    } catch (e) {
      return { content: e instanceof Error ? e.message : '工作目录无效', isError: true }
    }

    const streamer = createTerminalStreamer(ctx)
    let res
    try {
      res = await runCommand(input.command, {
        cwd,
        timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.signal,
        onData: (chunk) => streamer.onData(chunk)
      })
    } finally {
      streamer.flush()
    }

    const stdout = tailLines(res.stdout, MAX_STDOUT_TAIL_LINES)
    const prompt = process.platform === 'win32' ? 'PS' : '$'
    const parts: string[] = []
    parts.push(`${prompt} ${cwd}> ${input.command}`)
    if (res.awaitingInput) {
      parts.push(
        '(命令疑似在等待交互式输入而被终止：此终端是非交互式的，无法接受 y/n、密码或回车等按键输入。请改用非交互式参数重试，例如加上 -y/--yes/-Force/--non-interactive，设置 $env:CI=1 或 DEBIAN_FRONTEND=noninteractive，或用管道预先提供输入，如 "echo y | <命令>"。)'
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
