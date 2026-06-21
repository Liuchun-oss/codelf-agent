import { z } from 'zod'
import { listFiles, toRel } from '../../services/fsService'
import { resolveAnyPath } from './paths'
import type { Tool, ToolResult } from './types'
import { GLOB_DESCRIPTION, GLOB_NAME } from '../prompts/tools/glob'

const MAX_RESULTS = 1000
const MAX_CONTENT_CHARS = 60_000

const globSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern matched against workspace-relative paths, e.g. "*.ts" or "src/**/*.tsx"'),
  path: z.string().optional().describe('Optional workspace-relative directory to search within'),
  limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe('Maximum number of file paths to return')
})

type GlobInput = z.infer<typeof globSchema>

function normalizePattern(pattern: string): string {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.startsWith('**/') || normalized.includes('/')) return normalized
  return `**/${normalized}`
}

function capContent(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_CONTENT_CHARS) return { content: text, truncated: false }
  return { content: text.slice(0, MAX_CONTENT_CHARS) + '\n…（结果已截断）', truncated: true }
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    const next = pattern[i + 1]
    if (ch === '*') {
      if (next === '*') {
        const after = pattern[i + 2]
        if (after === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i++
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '/') {
      out += '/'
    } else {
      out += escapeRegex(ch)
    }
  }
  out += '$'
  return new RegExp(out, process.platform === 'win32' ? 'i' : '')
}

export const globTool: Tool<GlobInput> = {
  name: GLOB_NAME,
  description: GLOB_DESCRIPTION,
  schema: globSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.workspaceRoot) return { content: '未打开工作区', isError: true }

    let searchRoot = ctx.workspaceRoot
    try {
      if (input.path) searchRoot = resolveAnyPath(ctx.workspaceRoot, input.path)
    } catch (e) {
      return { content: e instanceof Error ? e.message : '路径无效', isError: true }
    }

    const pattern = normalizePattern(input.pattern)
    const matcher = globToRegExp(pattern)
    const limit = input.limit ?? 200
    const files = await listFiles(searchRoot)
    const matches = files
      .map((file) => toRel(ctx.workspaceRoot as string, file))
      .map((file) => file.replace(/\\/g, '/'))
      .filter((file) => matcher.test(file))
      .sort((a, b) => a.localeCompare(b))

    if (matches.length === 0) return { content: `No files matched ${input.pattern}.` }

    const shown = matches.slice(0, limit)
    const header = `Found ${matches.length} file(s) matching ${input.pattern}${matches.length > limit ? `; showing first ${limit}` : ''}:\n`
    const capped = capContent(header + shown.join('\n'))
    return { content: capped.content, truncated: capped.truncated || matches.length > limit }
  }
}
