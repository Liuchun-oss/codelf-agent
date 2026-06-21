import { z } from 'zod'
import { fetchDiagnosticsFromRenderer } from '../../services/diagnosticsBridge'
import { resolveAnyPath } from './paths'
import type { Tool, ToolResult } from './types'
import { GET_DIAGNOSTICS_NAME, GET_DIAGNOSTICS_DESCRIPTION } from '../prompts/tools/diagnostics'

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe('Optional file path (relative to workspace root). Omit to list all open-file diagnostics.')
})

type Input = z.infer<typeof schema>

function formatDiagnostics(
  rows: Awaited<ReturnType<typeof fetchDiagnosticsFromRenderer>>
): string {
  if (rows.length === 0) return 'No diagnostics reported.'
  return rows
    .map(
      (d) =>
        `${d.path}:${d.line}:${d.column} [${d.severity}]${d.source ? ` (${d.source})` : ''} ${d.message}`
    )
    .join('\n')
}

export const getDiagnosticsTool: Tool<Input> = {
  name: GET_DIAGNOSTICS_NAME,
  description: GET_DIAGNOSTICS_DESCRIPTION,
  schema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.workspaceRoot) {
      return { content: '未打开工作区，无法获取诊断', isError: true }
    }

    let rows = await fetchDiagnosticsFromRenderer()
    if (input.path) {
      try {
        const abs = resolveAnyPath(ctx.workspaceRoot, input.path)
        rows = rows.filter((r) => r.path.replace(/\\/g, '/') === abs.replace(/\\/g, '/'))
      } catch (e) {
        return { content: e instanceof Error ? e.message : '路径无效', isError: true }
      }
    }

    return { content: formatDiagnostics(rows) }
  }
}
